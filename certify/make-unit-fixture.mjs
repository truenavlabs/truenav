// Builds contract/tests/fixtures/tee-verdicts.json (read by contract/tests/tee_verdicts.rs) from the real TEE
// verdict set signed for registry.test.near:
//   node tee/underwrite.mjs --contract registry.test.near --out tee/fixtures/verdicts-unit.json
//   node certify/make-unit-fixture.mjs
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const v = JSON.parse(readFileSync(new URL("tee/fixtures/verdicts-unit.json", root), "utf8"));
const { loans } = JSON.parse(readFileSync(new URL("tee/loans.json", root), "utf8"));
if (v.contract_id !== "registry.test.near") throw new Error(`verdicts-unit.json is bound to ${v.contract_id}, not registry.test.near`);
const out = {
  note: "Real NEAR AI Cloud TEE-signed verdicts bound to registry.test.near (node tee/underwrite.mjs --contract registry.test.near). Model reply only; no document text.",
  model: v.model,
  signer: v.results[0].onchain.signer,
  attestation_nonce: v.attestation.nonce,
  attestation_sha256: v.attestation.report_sha256,
  signed_at_ms: v.signed_at_ms,
  expires_at_ms: v.expires_at_ms,
  records: v.results.map((r) => ({
    loan_id: r.loan_id,
    fund_id: r.fund_id,
    asset_type: (loans.find((l) => l.loan_hash === r.loan_hash) || {}).asset_type,
    tampered: r.tampered && r.tampered.id,
    expected_verdict: r.verdict.verdict,
    expected_anomalies: r.verdict.anomalies,
    ...r.onchain,
  })),
};
writeFileSync(new URL("contract/tests/fixtures/tee-verdicts.json", root), JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${out.records.length} records, signer ${out.signer}`);
