// Independent, read-only review of one NEAR transaction: confirms on chain what a TEE step did. Free RPC calls only
// (`tx` and `block`); no key, no signing, no sending.
//
//   npm run tee:tx-review -- <tx_hash> --sender <signer account> [--expect-receiver <id>] [--expect-method <name>]
//                                       [--verdicts <path>] [--rpc <url>]
//
// Prints the final status, signer, receiver, block, each function call (method, deposit, and a summary of its
// arguments: a verdict's response body is shown as its sha256 and length, never in full), and the result of every
// receipt. For `add_tee_signer` and `submit_verdict` it compares the arguments with the verdicts file.
// Exit 0 when the transaction succeeded and every --expect matches, 1 when not, 2 on a usage or network error.
import { failLine, nameEndpoint } from "../certify/net-guard.mjs"; // first: wraps fetch before other modules load
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { DEFAULT_RPC, BACKUP_RPCS } from "../web/chain.mjs";

const ROOT = new URL("../", import.meta.url);
const sha256hex = (s) => createHash("sha256").update(s).digest("hex");

function parseArgs(b64) {
  try { return JSON.parse(Buffer.from(b64, "base64").toString("utf8")); } catch { return null; }
}

/** Pure: summarise a `tx` RPC result. `file` is an optional parsed verdicts file to compare against. */
export function reviewTx(result, { file = null, expectReceiver, expectMethod } = {}) {
  const lines = [];
  const problems = [];
  const t = result.transaction || {};
  const status = result.status || {};
  const ok = status.SuccessValue !== undefined;
  const failure = status.Failure ? JSON.stringify(status.Failure).slice(0, 300) : null;
  lines.push(`tx ${t.hash}: ${ok ? "SUCCESS" : failure ? `FAILED ${failure}` : `status ${JSON.stringify(status).slice(0, 120)}`} (${result.final_execution_status || "?"})`);
  lines.push(`signer ${t.signer_id}  key ${t.public_key}  receiver ${t.receiver_id}`);
  if (!ok) problems.push("the transaction did not succeed");
  if (expectReceiver && t.receiver_id !== expectReceiver) problems.push(`receiver is ${t.receiver_id}, expected ${expectReceiver}`);
  const calls = (t.actions || []).filter((a) => a.FunctionCall).map((a) => a.FunctionCall);
  const other = (t.actions || []).filter((a) => !a.FunctionCall).map((a) => Object.keys(a)[0]);
  if (other.length) lines.push(`non-call actions: ${other.join(", ")}`);
  for (const c of calls) {
    const args = parseArgs(c.args);
    lines.push(`call ${c.method_name}  deposit ${c.deposit} yoctoNEAR  gas ${c.gas}`);
    if (expectMethod && c.method_name !== expectMethod) problems.push(`method is ${c.method_name}, expected ${expectMethod}`);
    if (!args) { lines.push("  args: not JSON"); continue; }
    if (c.method_name === "submit_verdict") {
      const body = String(args.response_body ?? "");
      const rsha = sha256hex(body);
      lines.push(`  loan_hash ${args.loan_hash}  model_id ${args.model_id}  request_sha256 ${args.request_sha256}`);
      lines.push(`  response_body: ${body.length} bytes, sha256 ${rsha} (not printed)`);
      if (file) {
        const rec = (file.results || []).find((r) => r.onchain?.response_body && sha256hex(r.onchain.response_body) === rsha);
        if (!rec) problems.push("no record in the verdicts file has this response body");
        else {
          lines.push(`  matches verdicts file record ${rec.loan_id} (${rec.verdict?.verdict})`);
          if (rec.loan_hash !== args.loan_hash) problems.push("loan_hash differs from the file record");
          if (rec.onchain.signature !== args.signature) problems.push("signature differs from the file record");
          if (rec.onchain.request_sha256 !== args.request_sha256) problems.push("request_sha256 differs from the file record");
        }
      }
    } else if (c.method_name === "add_tee_signer") {
      lines.push(`  address ${args.address}  model_id ${args.model_id}  attestation_sha256 ${args.attestation_sha256}`);
      if (file) {
        const signer = file.results?.[0]?.onchain?.signer;
        if (String(args.address).toLowerCase() !== signer) problems.push(`address is not the file's signer ${signer}`);
        if (args.model_id !== file.model) problems.push(`model_id is not the file's ${file.model}`);
        if (args.attestation_sha256 !== file.attestation?.report_sha256) problems.push("attestation_sha256 is not the sha256 of the file's report");
      }
    } else {
      lines.push(`  args: ${Object.entries(args).map(([k, v]) => `${k}=${String(typeof v === "string" ? v.slice(0, 70) : JSON.stringify(v)).slice(0, 70)}`).join(", ").slice(0, 300)}`);
    }
  }
  for (const r of result.receipts_outcome || []) {
    const s = r.outcome?.status || {};
    const st = s.SuccessValue !== undefined ? "success" : s.SuccessReceiptId ? "success (receipt follows)" : s.Failure ? `FAILED ${JSON.stringify(s.Failure).slice(0, 160)}` : "?";
    lines.push(`receipt ${String(r.id).slice(0, 10)}... on ${r.outcome?.executor_id}: ${st}${r.outcome?.logs?.length ? `, ${r.outcome.logs.length} log line(s)` : ""}`);
    if (s.Failure) problems.push(`a receipt on ${r.outcome?.executor_id} failed`);
  }
  return { ok: problems.length === 0, lines, problems, block_hash: result.transaction_outcome?.block_hash ?? null };
}

async function rpcOnce(url, method, params) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "review", method, params }) });
  if (!r.ok) throw new Error(`RPC ${method} failed: HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`RPC ${method} failed: ${j.error.message || JSON.stringify(j.error.data || j.error).slice(0, 200)}`);
  return j.result;
}
export async function fetchTx(url, txHash, sender) {
  const urls = url === DEFAULT_RPC ? [DEFAULT_RPC, ...BACKUP_RPCS] : [url];
  let last;
  for (const u of urls) {
    try {
      const res = await rpcOnce(u, "tx", { tx_hash: txHash, sender_account_id: sender, wait_until: "FINAL" });
      let height = null;
      try { height = (await rpcOnce(u, "block", { block_id: res.transaction_outcome.block_hash })).header; } catch { /* the block line is optional */ }
      return { result: res, header: height };
    } catch (e) { last = e; }
  }
  throw last;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const known = ["--sender", "--expect-receiver", "--expect-method", "--verdicts", "--rpc"];
  const pos = args.filter((a, i) => !a.startsWith("--") && !known.includes(args[i - 1]));
  const bad = args.find((a) => a.startsWith("--") && !known.includes(a));
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  const hash = pos[0];
  if (bad || pos.length !== 1 || !/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(hash || "") || !opt("--sender")) {
    console.error("usage: npm run tee:tx-review -- <tx_hash> --sender <signer account> [--expect-receiver <id>] [--expect-method <name>] [--verdicts <path>] [--rpc <url>]");
    process.exit(2);
  }
  let file = null;
  const vp = opt("--verdicts");
  if (vp) { if (!existsSync(vp) && !existsSync(new URL(vp, ROOT))) { console.error(`no verdicts file at ${vp}`); process.exit(2); } file = JSON.parse(readFileSync(existsSync(vp) ? vp : new URL(vp, ROOT), "utf8")); }
  try {
    const rpcUrl = opt("--rpc") || process.env.TRUENAV_RPC || DEFAULT_RPC;
    nameEndpoint(rpcUrl, "NEAR RPC", "--rpc or TRUENAV_RPC");
    const { result, header } = await fetchTx(rpcUrl, hash, opt("--sender"));
    const r = reviewTx(result, { file, expectReceiver: opt("--expect-receiver"), expectMethod: opt("--expect-method") });
    for (const l of r.lines) console.log(l);
    if (header) console.log(`block ${header.height} at ${new Date(Number(BigInt(header.timestamp_nanosec) / 1000000n)).toISOString()}`);
    for (const p of r.problems) console.log(`FAIL ${p}`);
    console.log(r.ok ? "PASS the transaction succeeded and matches what was expected" : "FAIL see above");
    process.exit(r.ok ? 0 : 1);
  } catch (e) { console.error(failLine(e)); process.exit(2); }
}
