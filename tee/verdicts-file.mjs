// Validates a TEE verdicts file (the format tee/underwrite.mjs writes, e.g. tee/fixtures/verdicts.json or a new
// tee/fixtures/verdicts-368aa2.json) with no network, no NEAR AI Cloud key and no chain access:
//   structure, the binding (contract, network, expiry), the 30 day lifetime, every record's EIP-191 signature over
//   "<model>:<request sha256>:<response sha256>" against the attested signer, the reply rule (tee/reply.mjs), and that
//   the signed reply names this record's loan_hash and the file's binding.
// It does not prove the signer is attested (npm run verify:attestation does that, with the published report) and does
// not read the chain. A file that passes here is well formed and internally consistent, not necessarily live.
//
//   node tee/verdicts-file.mjs <file> [--contract <id>] [--min-days <n>]     exit 0 when valid
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { bindingFor, eip191Recover, readVerdict, VERDICT_TTL_MS } from "./underwrite.mjs";
import { replyProblem, ANOMALY_CODES } from "./reply.mjs";

const HEX64 = /^[0-9a-f]{64}$/;
const ADDR = /^0x[0-9a-f]{40}$/;
const SIG = /^0x[0-9a-fA-F]{130}$/;
const ACCOUNT = /^[a-z0-9._-]+\.(testnet|near)$/;
const CHECK_NAMES = ["signature_kind_provider_tee", "text_matches_exact_bytes", "recovered_equals_signing_address", "signer_attested_with_fresh_nonce", "verdict_bound_to_loan_hash", "binding_echoed_exactly", "reply_keys_allowed"];
const sha256hex = (s) => createHash("sha256").update(s).digest("hex");
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isMs = (v) => Number.isSafeInteger(v) && v > 0;

/** @returns {{ ok: boolean, problems: string[], records: number, signer: string|null, expires_at_ms: number|null }} */
export function validateVerdictsFile(file, { contract, nowMs, minDays } = {}) {
  const problems = [];
  const bad = (m) => problems.push(m);
  if (!isObj(file)) return { ok: false, problems: ["the file is not a JSON object"], records: 0, signer: null, expires_at_ms: null };

  if (typeof file.note !== "string" || !file.note) bad("note must be a non-empty string");
  if (typeof file.model !== "string" || !file.model) bad("model must be a non-empty string");
  if (typeof file.contract_id !== "string" || !ACCOUNT.test(file.contract_id)) bad("contract_id must be a testnet or mainnet account id");
  if (contract !== undefined && file.contract_id !== contract) bad(`contract_id is ${file.contract_id}, expected ${contract}`);
  if (!isMs(file.signed_at_ms)) bad("signed_at_ms must be a positive integer (milliseconds)");
  if (!isMs(file.expires_at_ms)) bad("expires_at_ms must be a positive integer (milliseconds)");
  if (isMs(file.signed_at_ms) && isMs(file.expires_at_ms) && file.expires_at_ms - file.signed_at_ms !== VERDICT_TTL_MS) bad("expires_at_ms must be signed_at_ms plus 30 days");
  if (typeof file.contract_id === "string" && ACCOUNT.test(file.contract_id) && isMs(file.expires_at_ms) && file.binding !== bindingFor(file.contract_id, file.expires_at_ms)) {
    bad(`binding must be ${bindingFor(file.contract_id, file.expires_at_ms)}`);
  }
  if (nowMs !== undefined && isMs(file.expires_at_ms)) {
    const days = (file.expires_at_ms - nowMs) / 86400000;
    if (days <= 0) bad("the verdict set is expired");
    else if (minDays !== undefined && days < minDays) bad(`the verdict set has ${days.toFixed(1)} days left (minimum ${minDays})`);
  }

  const att = file.attestation;
  const attested = new Set();
  if (!isObj(att)) bad("attestation must be an object");
  else {
    if (!HEX64.test(att.nonce ?? "")) bad("attestation.nonce must be 64 lowercase hex");
    if (typeof att.checked_at !== "string" || Number.isNaN(Date.parse(att.checked_at))) bad("attestation.checked_at must be a timestamp");
    if (!HEX64.test(att.report_sha256 ?? "")) bad("attestation.report_sha256 must be 64 lowercase hex");
    if (!Array.isArray(att.sections)) bad("attestation.sections must be an array");
    else if (att.sections.some((s) => !isObj(s) || typeof s.name !== "string" || !Array.isArray(s.checks) || s.checks.some((c) => !isObj(c) || typeof c.pass !== "boolean"))) bad("attestation.sections entries must have a name and checks with pass booleans");
    else if (att.sections.some((s) => s.checks.some((c) => c.pass !== true))) bad("an attestation check did not pass");
    if (!Array.isArray(att.signers) || att.signers.length === 0) bad("attestation.signers must be a non-empty array");
    else for (const s of att.signers) {
      if (!isObj(s) || s.signing_algo !== "ecdsa" || !ADDR.test(String(s.signing_address).toLowerCase())) bad("each attestation signer must be ecdsa with a 0x address");
      else attested.add(s.signing_address.toLowerCase());
    }
  }

  const signers = new Set();
  const results = file.results;
  if (!Array.isArray(results) || results.length === 0) bad("results must be a non-empty array");
  else results.forEach((r, i) => {
    const at = `results[${i}]${isObj(r) && typeof r.loan_id === "string" ? ` (${r.loan_id})` : ""}`;
    const rb = (m) => bad(`${at}: ${m}`);
    if (!isObj(r)) return rb("must be an object");
    if (typeof r.loan_id !== "string" || !r.loan_id) rb("loan_id must be a non-empty string");
    if (typeof r.fund_id !== "string" || !r.fund_id) rb("fund_id must be a non-empty string");
    if (!HEX64.test(r.loan_hash ?? "")) rb("loan_hash must be 64 lowercase hex");
    if (r.tampered !== null && !(isObj(r.tampered) && typeof r.tampered.id === "string" && ANOMALY_CODES.includes(r.tampered.expected_anomaly))) rb("tampered must be null or { id, expected_anomaly }");
    if (r.ok !== true) rb("ok must be true: an unverified record does not belong in a published set");
    if (!isObj(r.checks) || CHECK_NAMES.some((k) => r.checks[k] !== true) || Object.keys(r.checks).some((k) => !CHECK_NAMES.includes(k))) rb(`checks must be exactly ${CHECK_NAMES.length} named checks, all true`);
    const on = r.onchain;
    if (!isObj(on)) return rb("onchain must be an object");
    if (on.loan_hash !== r.loan_hash) rb("onchain.loan_hash must equal loan_hash");
    if (on.model_id !== file.model) rb("onchain.model_id must equal the file's model");
    if (!HEX64.test(on.request_sha256 ?? "")) rb("onchain.request_sha256 must be 64 lowercase hex");
    if (typeof on.response_body !== "string") return rb("onchain.response_body must be a string");
    if (!SIG.test(on.signature ?? "")) return rb("onchain.signature must be 0x plus 130 hex");
    if (!ADDR.test(on.signer ?? "")) return rb("onchain.signer must be a lowercase 0x address");
    signers.add(on.signer);
    if (attested.size && !attested.has(on.signer)) rb("onchain.signer is not an attested signer");
    // the signature covers exactly this text, so a swapped model, request hash or response invalidates it
    let recovered = null;
    try { recovered = eip191Recover(`${file.model}:${on.request_sha256}:${sha256hex(on.response_body)}`, on.signature); } catch { /* reported below */ }
    if (recovered !== on.signer) rb("the signature does not recover to onchain.signer over model:request_sha256:response_sha256");
    const problem = replyProblem(on.response_body);
    if (problem !== null) return rb(`reply rule: ${problem}`);
    let v;
    try { v = readVerdict(Buffer.from(on.response_body, "utf8")); } catch { return rb("the signed reply cannot be read"); }
    if (v.loan_hash !== r.loan_hash) rb("the signed reply names another loan_hash");
    if (v.binding !== file.binding) rb("the signed reply echoes another binding");
    if (!isObj(r.verdict) || r.verdict.verdict !== v.verdict || JSON.stringify(r.verdict.anomalies) !== JSON.stringify(v.anomalies)) rb("verdict does not match the signed reply");
  });
  if (signers.size > 1) bad("the records are signed by more than one key");
  return { ok: problems.length === 0, problems, records: Array.isArray(results) ? results.length : 0, signer: signers.size === 1 ? [...signers][0] : null, expires_at_ms: isMs(file.expires_at_ms) ? file.expires_at_ms : null };
}

export const validateVerdictsPath = (path, opts) => validateVerdictsFile(JSON.parse(readFileSync(path, "utf8")), opts);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const path = args.find((a, i) => !a.startsWith("--") && !String(args[i - 1]).startsWith("--"));
  if (!path) {
    console.error("usage: node tee/verdicts-file.mjs <file> [--contract <id>] [--min-days <n>]");
    process.exit(2);
  }
  const minDays = opt("--min-days") === undefined ? undefined : Number(opt("--min-days"));
  const r = validateVerdictsPath(path, { contract: opt("--contract"), nowMs: Date.now(), minDays });
  for (const p of r.problems) console.log(`FAIL ${p}`);
  console.log(`${r.ok ? "PASS" : "FAIL"} ${path}: ${r.records} records, signer ${r.signer ?? "(none or mixed)"}${r.expires_at_ms ? `, ${((r.expires_at_ms - Date.now()) / 86400000).toFixed(1)} days left` : ""}`);
  process.exit(r.ok ? 0 : 1);
}
