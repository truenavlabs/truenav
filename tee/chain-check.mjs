// Read-only check that a TEE verdict set is on the registry chain, with free RPC view calls only. No key, no
// transaction, no NEAR AI Cloud call. For registry.tnlab-368aa2.testnet (or --contract) it confirms:
//   1. the verdicts file is bound to that registry and validates offline (tee/verdicts-file.mjs)
//   2. the registered TEE signer on chain is the file's signer, with the file's model and the sha256 of the published
//      attestation report
//   3. the binding and expiry: the file's binding names this contract and its expiry, and has not passed
//   4. every honest verdict in the file is on chain: a stored verdict with the same response sha256, signer, model, request
//      hash, verdict, anomalies, expiry and attestation hash. Trap records (tampered documents, `tampered` set in the file)
//      are expected NOT to be on chain; one that is fails the check unless --allow-traps is given.
//
//   npm run tee:chain-check [-- --contract <id>] [--verdicts <path>] [--report <path>] [--rpc <url>] [--allow-traps]
// Exit 0 when every check passes, 1 when one fails, 2 on a usage or network error.
// It is an optional step of the judge path (not part of `npm run judge`): it needs the network and a verdict set.
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { validateVerdictsFile } from "./verdicts-file.mjs";
import { bindingFor } from "./underwrite.mjs";
import { readStatus } from "./status.mjs";
import { view as chainView, DEFAULT_RPC } from "../web/chain.mjs";

const ROOT = new URL("../", import.meta.url);
const sha256hex = (s) => createHash("sha256").update(s).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const PAGE = 100;

/** @returns {Promise<{ ok: boolean, checks: {ok: boolean, text: string}[] }>} */
export async function chainCheck({ file, contract, reportSha256 = null, view, nowMs = Date.now(), allowTraps = false }) {
  const checks = [];
  const add = (ok, text) => checks.push({ ok: !!ok, text });

  // 1. the file
  add(file?.contract_id === contract, `the verdicts file is bound to ${contract} (it says ${file?.contract_id})`);
  const v = validateVerdictsFile(file, { contract, nowMs });
  add(v.ok, v.ok ? `the verdicts file validates offline: ${v.records} records, signer ${v.signer}` : `the verdicts file does not validate offline: ${v.problems.slice(0, 3).join("; ")}`);
  const reportOk = reportSha256 === null || reportSha256 === file?.attestation?.report_sha256;
  if (reportSha256 !== null) add(reportOk, `the attestation report file has the sha256 the verdicts record (${file?.attestation?.report_sha256})`);
  if (!v.ok || !reportOk) return { ok: false, checks };

  // 2. the registered TEE signer
  const signers = await view(contract, "get_tee_signers", {});
  const reg = (signers || []).find((s) => String(s.address).toLowerCase() === v.signer);
  add(!!reg, `${v.signer} is a registered TEE signer on ${contract}${reg ? "" : ` (registered: ${(signers || []).map((s) => s.address).join(", ") || "none"})`}`);
  if (reg) {
    add(reg.model_id === file.model, `the registered model is ${file.model} (chain: ${reg.model_id})`);
    add(reg.attestation_sha256 === file.attestation.report_sha256, `the registered attestation sha256 is the published report's ${file.attestation.report_sha256} (chain: ${reg.attestation_sha256})`);
  }

  // 3. binding and expiry
  add(file.binding === bindingFor(contract, file.expires_at_ms), `the binding names ${contract}, testnet or mainnet by suffix, and expiry ${file.expires_at_ms}`);
  const days = (file.expires_at_ms - nowMs) / 86400000;
  add(days > 0, days > 0 ? `the set has ${days.toFixed(1)} days left` : "the set is expired");

  // 4. every verdict
  for (const r of file.results) {
    const hash = r.loan_hash;
    const want = sha256hex(r.onchain.response_body);
    let stored = [];
    for (let from = 0; ; from += PAGE) {
      const page = await view(contract, "get_verdicts_page", { loan_hash: hash, from_index: from, limit: PAGE });
      stored = stored.concat(page || []);
      if (!page || page.length < PAGE) break;
    }
    const hit = stored.find((s) => s.response_sha256 === want);
    const label = `${r.loan_id} ${hash.slice(0, 12)}...`;
    if (r.tampered) {
      // trap records (a tampered document each) are in the file on purpose and are not submitted
      if (hit) add(allowTraps, allowTraps ? `${label}: trap record ${r.tampered.id} is on chain (allowed by --allow-traps)` : `${label}: trap record ${r.tampered.id} is on chain, but the plan was not to submit it (use --allow-traps if that changed)`);
      else add(true, `${label}: trap record ${r.tampered.id} is not on chain, as intended`);
      continue;
    }
    if (!hit) { add(false, `${label}: no stored verdict with response sha256 ${want.slice(0, 12)}... (${stored.length} stored for this loan)`); continue; }
    const diffs = [];
    if (String(hit.signer).toLowerCase() !== v.signer) diffs.push("signer");
    if (hit.model_id !== file.model) diffs.push("model_id");
    if (hit.request_sha256 !== r.onchain.request_sha256) diffs.push("request_sha256");
    if (hit.verdict !== r.verdict.verdict) diffs.push("verdict");
    if (!same(hit.anomalies, r.verdict.anomalies)) diffs.push("anomalies");
    if (Number(hit.expires_at_ms) !== file.expires_at_ms) diffs.push("expires_at_ms");
    if (hit.attestation_sha256 !== file.attestation.report_sha256) diffs.push("attestation_sha256");
    add(diffs.length === 0, diffs.length ? `${label}: stored verdict differs from the file in ${diffs.join(", ")}` : `${label}: on chain, ${hit.verdict}${hit.anomalies?.length ? ` (${hit.anomalies.join(", ")})` : ""}, expires ${new Date(Number(hit.expires_at_ms)).toISOString().slice(0, 10)}`);
  }
  return { ok: checks.every((c) => c.ok), checks };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const known = ["--contract", "--verdicts", "--report", "--rpc"];
  const bad = args.find((a, i) => a.startsWith("--") ? ![...known, "--allow-traps"].includes(a) : !known.includes(args[i - 1]));
  if (bad) { console.error(`unknown argument ${bad}`); process.exit(2); }
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  const status = readStatus();
  const contract = opt("--contract") || process.env.TRUENAV_CONTRACT || status.registry;
  const verdictsPath = opt("--verdicts") || status.verdicts_file || "tee/fixtures/verdicts-368aa2.json";
  const reportPath = opt("--report") || status.report_file || "tee/fixtures/attestation-report-368aa2.json.b64";
  const rpcUrl = opt("--rpc") || process.env.TRUENAV_RPC || DEFAULT_RPC;
  if (!existsSync(new URL(verdictsPath, ROOT)) && !existsSync(verdictsPath)) { console.error(`no verdicts file at ${verdictsPath}: nothing to check yet (TEE status is ${status.tee})`); process.exit(2); }
  const read = (p) => readFileSync(existsSync(p) ? p : new URL(p, ROOT), "utf8");
  const file = JSON.parse(read(verdictsPath));
  const reportSha256 = existsSync(new URL(reportPath, ROOT)) || existsSync(reportPath) ? sha256hex(Buffer.from(read(reportPath).replace(/\s+/g, ""), "base64")) : null;
  try {
    const r = await chainCheck({ file, contract, reportSha256, view: (c, m, a) => chainView(c, m, a, rpcUrl), allowTraps: args.includes("--allow-traps") });
    for (const c of r.checks) console.log(`${c.ok ? "PASS" : "FAIL"} ${c.text}`);
    console.log(r.ok ? `PASS every check: the verdict set in ${verdictsPath} is on ${contract}` : `FAIL the verdict set in ${verdictsPath} is not fully on ${contract}`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(2);
  }
}
