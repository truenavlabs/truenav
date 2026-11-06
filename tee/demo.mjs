// Tamper demo (owner decision 6 Nov): shows each tampered document flagged by the TEE underwriter and what a
// flag does to the score. Runs offline with no API key: it replays the TEE-signed replies stored in
// tee/fixtures/verdicts.json and re-checks every signature here. To rerun the documents through the TEE live
// (needs a NEAR AI Cloud key): npm run tee:underwrite -- --only T
//
//   npm run tee:demo
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { scorePortfolio } from "../engine/src/score.mjs";
import { eip191Recover, readVerdict } from "./underwrite.mjs";

const root = new URL("../", import.meta.url);
const tee = JSON.parse(readFileSync(new URL("tee/fixtures/verdicts.json", root), "utf8"));
const fx = JSON.parse(readFileSync(new URL("spec/nav/fixtures.json", root), "utf8"));
const sha256hex = (s) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
const attested = tee.attestation.signers.map((s) => s.signing_address.toLowerCase());

console.log(`TEE: ${tee.model} in NEAR AI Cloud, signer ${attested.join(", ")}`);
console.log(`Attested ${tee.attestation.checked_at} with fresh nonce ${tee.attestation.nonce.slice(0, 16)}...: ${tee.attestation.sections.map((s) => `${s.name} ${s.checks.every((c) => c.pass) ? "PASS" : "FAIL"}`).join("; ")}\n`);

let allOk = true;
for (const r of tee.results) {
  const o = r.onchain;
  const text = `${o.model_id}:${o.request_sha256}:${sha256hex(o.response_body)}`;
  const signer = eip191Recover(text, o.signature);
  const v = readVerdict(Buffer.from(o.response_body, "utf8"));
  const sigOk = attested.includes(signer) && v.loan_hash === o.loan_hash;
  const label = r.tampered ? `${r.tampered.id.padEnd(20)} expected ${r.tampered.expected_anomaly}` : r.loan_id;
  if (r.tampered) console.log(`${sigOk ? "signed by TEE" : "BAD SIGNATURE"}  ${label}  ->  ${v.verdict} ${v.anomalies.join(", ")}`);
  allOk &&= sigOk && (r.tampered ? v.verdict === "flag" && v.anomalies.includes(r.tampered.expected_anomaly) : v.verdict === "pass");
}
const honest = tee.results.filter((r) => !r.tampered);
console.log(`honest documents: ${honest.filter((r) => r.verdict.verdict === "pass").length} of ${honest.length} pass, every signature checked\n`);

// Score impact: H-RE-01's tampered copy (T1) gets a flag on chain; the latest verdict counts.
const loans = JSON.parse(readFileSync(new URL("tee/loans.json", root), "utf8")).loans.filter((l) => !l.tampered);
const now = Date.parse(fx.valuation_time);
const funds = JSON.parse(JSON.stringify(fx.funds));
for (const f of funds) for (const l of f.loans) {
  const m = loans.find((x) => x.fund_id === f.fund_id && x.loan_id === l.id);
  if (m) l.loan_hash = m.loan_hash;
}
const store = Object.fromEntries(honest.map((r) => [r.loan_hash, { pledged_at_ms: now - 4 * 86400000, latest: r.verdict }]));
const score = (st) => scorePortfolio({ pd: fx.pd, lgd: fx.lgd }, JSON.parse(JSON.stringify(funds)), { now: fx.valuation_time, certStore: fx.cert_store, teeStore: st }).find((r) => r.fundId === "harbor-credit-fund");
const before = score(store);
const t1 = tee.results.find((r) => r.tampered && r.tampered.id === "T1-altered-amount");
const after = score({ ...store, [t1.loan_hash]: { ...store[t1.loan_hash], latest: t1.verdict } });
const fmt = (r) => `${(Math.round(r.raw * 100) / 100).toFixed(2)} ${r.band}`;
console.log(`Harbor with every document passing:      ${fmt(before)}`);
console.log(`Harbor after the TEE flags H-RE-01 (T1): ${fmt(after)}  (${after.unverified.reasons.find((x) => x.id === "H-RE-01").reason})`);
process.exitCode = allOk ? 0 : 1;
