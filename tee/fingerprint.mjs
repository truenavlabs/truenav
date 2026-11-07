// Private loan fingerprints (owner decision D1, 7 Nov). A loan's on-chain loan_hash is
//   HMAC-SHA256(key, "truenav-fp-v1|" + asset type + "|" + document id)
// computed by the OutLayer TEE module outlayer/fingerprint. The key is derived inside the TEE for the project and
// the calling account (the servicer); the module never sees it and nobody holds it, so nobody can recompute a
// fingerprint from a document id or test a guess against one. The servicer is the one place fingerprints come from
// (TRUST_MODEL). Requests go over HTTPS only (on chain the input would be public), with a random nonce so the
// run's public attestation (which carries sha256 of the input) cannot be matched against guesses either.
//
//   PAYMENT_KEY=<servicer payment key> node tee/fingerprint.mjs     writes tee/fixtures/fingerprints.json
//   npm run verify:fingerprints                                       re-checks every recorded fingerprint, no key
import { readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";

export const FP_API = process.env.TRUENAV_OUTLAYER_API || "https://testnet-api.outlayer.ai";
export const FP_PROJECT = "servicer.tnlab-718ca9.testnet/truenav-fingerprint";
export const FP_CALLER = "servicer.tnlab-718ca9.testnet";
/** sha256 of the deployed outlayer/fingerprint wasm (FastFS); `cargo build --release --target wasm32-wasip2` */
export const FP_WASM_SHA256 = "f2a880319fa2cf9917f062bb9c3da2342ca2c50a924c0899835a2fa499cdc71c";
export const FP_DOMAIN = "truenav-fp-v1";
const sha = (s) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
/**
 * A document id must already be canonical (uppercase letters, digits and hyphens): the module hashes it as given,
 * so "INV-1" and " inv-1" would give two fingerprints for one loan and a double pledge would not collide (7 Nov
 * audit). The client refuses anything else rather than rewriting it; normalizing inside the module is an owner call.
 */
export const isCanonicalId = (id) => typeof id === "string" && /^[A-Z0-9][A-Z0-9-]{0,127}$/.test(id);

/** Offsets in an Intel TDX v4 quote: 48-byte header, then the TD report body. */
const TD = { mrtd: 184, rtmr0: 376, rtmr1: 424, rtmr2: 472, rtmr3: 520, reportData: 568 };
export function quoteFields(quote) {
  const hex = (o, n = 48) => quote.subarray(o, o + n).toString("hex");
  return { mrtd: hex(TD.mrtd), rtmr0: hex(TD.rtmr0), rtmr1: hex(TD.rtmr1), rtmr2: hex(TD.rtmr2), rtmr3: hex(TD.rtmr3), report_data: hex(TD.reportData, 64) };
}
/**
 * The task hash an OutLayer worker writes into report_data[0..32] (OutLayer WORKER_ATTESTATION.md: SHA-256 of the task
 * fields in order, absent fields skipped, integers little-endian). Encoding confirmed against real quotes on 7 Nov:
 * strings and hex hashes as UTF-8 text, task_id and timestamp as u64 LE, no length prefixes.
 */
export function taskHash(att) {
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const t = (s) => Buffer.from(String(s), "utf8");
  const parts = [t(att.task_type), u64(att.task_id)];
  for (const k of ["repo", "commit"]) if (att[k]) parts.push(t(att[k]));
  parts.push(t(att.build_target), t(att.wasm_hash), t(att.input_hash), t(att.output_hash));
  if (att.block_height !== undefined && att.block_height !== null) parts.push(u64(att.block_height));
  parts.push(t(att.caller_account_id));
  if (att.project_id) parts.push(t(att.project_id));
  if (att.secrets_ref) parts.push(t(att.secrets_ref));
  parts.push(u64(att.timestamp), t(att.attached_usd));
  return createHash("sha256").update(Buffer.concat(parts)).digest("hex");
}

/** One fingerprint over HTTPS. Returns what the verifier needs; the payment key is never returned or logged. */
export async function fingerprint(assetType, documentId, paymentKey = process.env.PAYMENT_KEY) {
  if (!paymentKey) throw new Error("PAYMENT_KEY (the servicer's OutLayer payment key) is not set");
  if (assetType !== "real_estate" && assetType !== "invoices") throw new Error("asset type must be real_estate or invoices");
  if (!isCanonicalId(documentId)) throw new Error(`document id ${JSON.stringify(documentId)} is not canonical (A-Z, 0-9, hyphen)`);
  const input = { asset_type: assetType, document_id: documentId, nonce: randomBytes(16).toString("hex") };
  const r = await fetch(`${FP_API}/call/${FP_PROJECT}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Payment-Key": paymentKey }, body: JSON.stringify({ input, async: false }) });
  const j = await r.json();
  if (!r.ok || !j.output || !j.output.loan_hash) throw new Error(`fingerprint failed: ${r.status} ${JSON.stringify(j.error || j).slice(0, 200)}`);
  return { asset_type: assetType, document_id: documentId, loan_hash: j.output.loan_hash, call_id: j.call_id, input: JSON.stringify(input), output: JSON.stringify(j.output) };
}

/** Fetch a run's public attestation by call id (no key). It appears a few seconds after the run. */
export async function attestationOf(callId, tries = 10) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(`${FP_API}/attestations/by-call/${encodeURIComponent(callId)}`);
    if (r.ok) return r.json();
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error(`no attestation for call ${callId}`);
}

/**
 * Check one recorded fingerprint against its attestation: the pinned wasm ran, in this project, for the servicer,
 * on exactly the recorded input, and produced exactly this loan_hash. `verifyQuote` (optional) checks the Intel TDX
 * quote. Returns a list of [ok, label] lines.
 */
export async function checkFingerprint(rec, att, verifyQuote) {
  const out = JSON.parse(rec.output);
  const input = JSON.parse(rec.input);
  const quote = Buffer.from(att.tdx_quote || "", "base64");
  const q = quote.length > 632 ? quoteFields(quote) : null;
  const lines = [
    [isCanonicalId(rec.document_id), "document id is canonical"],
    [!!q && q.report_data === taskHash(att) + "0".repeat(64), "the TDX quote's report_data commits to this run (wasm, input, output, caller, project)"],
    [att.executed_wasm_sha256 === FP_WASM_SHA256 && att.wasm_hash === FP_WASM_SHA256, "the pinned fingerprint wasm ran"],
    [att.project_id === FP_PROJECT && att.caller_account_id === FP_CALLER, `project ${FP_PROJECT}, caller ${FP_CALLER}`],
    [att.input_hash === sha(rec.input) && input.asset_type === rec.asset_type && input.document_id === rec.document_id, "input hash matches the recorded input"],
    [att.output_hash === sha(rec.output) && out.loan_hash === rec.loan_hash && out.domain === FP_DOMAIN, "output hash matches the recorded loan_hash"],
  ];
  if (verifyQuote) {
    try {
      const v = await verifyQuote(Buffer.from(att.tdx_quote, "base64"));
      lines.push([v.status === "UpToDate", `Intel TDX quote verified (${v.status})`]);
    } catch (e) {
      lines.push([false, `Intel TDX quote: ${String(e.message || e).slice(0, 80)}`]);
    }
  }
  return lines;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = new URL("../", import.meta.url);
  const fx = JSON.parse(readFileSync(new URL("spec/nav/fixtures.json", root), "utf8"));
  // The demo's document ids, exactly as tee/docs.mjs names them, plus the tampered duplicate's new id.
  const docId = (fund, l) => `${l.asset === "real_estate" ? "TITLE" : "INV"}-DEMO-${fund === "harbor-credit-fund" ? "H" : "M"}${l.id.split("-").slice(1).join("")}`;
  const want = [];
  for (const f of fx.funds) for (const l of f.loans) if (l.nft) want.push([l.asset, docId(f.fund_id, l)]);
  want.push(["real_estate", "TITLE-DEMO-HRE09"]);
  const records = [];
  for (const [asset, id] of want) {
    const rec = await fingerprint(asset, id);
    records.push(rec);
    console.log(`${id}: ${rec.loan_hash.slice(0, 16)}... call ${rec.call_id}`);
  }
  writeFileSync(new URL("tee/fixtures/fingerprints.json", root), JSON.stringify({
    note: "Demo loan fingerprints from the OutLayer TEE (outlayer/fingerprint). Fictional documents, so the inputs are published to let anyone re-check each attestation (npm run verify:fingerprints); real inputs would stay private.",
    project: FP_PROJECT, caller: FP_CALLER, wasm_sha256: FP_WASM_SHA256, domain: FP_DOMAIN, api: FP_API, created_at: new Date().toISOString(), records,
  }, null, 2) + "\n");
  console.log(`wrote ${records.length} fingerprints to tee/fixtures/fingerprints.json`);
}
