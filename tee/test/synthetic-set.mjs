// A complete, validly signed synthetic verdicts file for tests, using the shape tee/underwrite.mjs writes. Signed with a
// throwaway key derived from a label, never a real signer. No network, no key material in the repository.
import { createHash } from "node:crypto";
import { signEip191, addressOf } from "../../certify/certificate.mjs";
import { bindingFor, VERDICT_TTL_MS } from "../underwrite.mjs";

export const REGISTRY = "registry.tnlab-368aa2.testnet";
export const sha = (s) => createHash("sha256").update(s).digest("hex");
const KEY = Uint8Array.from(createHash("sha256").update("truenav synthetic verdict-set test, not a real signer").digest());
export const SIGNER = addressOf(KEY).toLowerCase();
export const SIGNED_AT = Date.parse("2026-11-12T00:00:00Z");
export const REPORT_BYTES = Buffer.from("synthetic attestation report bytes");
export const REPORT_SHA = sha(REPORT_BYTES);
export const REPORT_B64 = REPORT_BYTES.toString("base64");
const group = (h) => h.match(/.{8}/g).join(" ");
const CHECKS = ["signature_kind_provider_tee", "text_matches_exact_bytes", "recovered_equals_signing_address", "signer_attested_with_fresh_nonce", "verdict_bound_to_loan_hash", "binding_echoed_exactly", "reply_keys_allowed"];

export function syntheticSet({ contract = REGISTRY, signedAt = SIGNED_AT, n = 3, model = "synthetic/test-model" } = {}) {
  const expires = signedAt + VERDICT_TTL_MS;
  const binding = bindingFor(contract, expires);
  const results = [];
  for (let i = 0; i < n; i++) {
    const tampered = i === n - 1 ? { id: "T1-altered-amount", expected_anomaly: "amount_mismatch" } : null;
    const loan_hash = sha(`synthetic loan ${i}`);
    const verdict = tampered ? "flag" : "pass";
    const anomalies = tampered ? ["amount_mismatch"] : [];
    const reply = { loan_hash: group(loan_hash), binding, id_mismatch: "ok", asset_mismatch: "ok", amount_mismatch: tampered ? "fail" : "ok", duplicate_document: "ok", duplicate_evidence_line: "ok", injection_attempt: "ok", unreadable: "ok", verdict, anomalies };
    const response_body = JSON.stringify({ id: `chatcmpl-synthetic-${i}`, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(reply) }, finish_reason: "stop" }] });
    const request_sha256 = sha(`synthetic request ${i}`);
    const signature = signEip191(`${model}:${request_sha256}:${sha(response_body)}`, KEY);
    results.push({
      loan_id: `S-${i}`, fund_id: "synthetic-fund", loan_hash, tampered,
      verdict: { loan_hash, binding, verdict, anomalies, duplicate_evidence_line: "ok" },
      checks: Object.fromEntries(CHECKS.map((k) => [k, true])),
      ok: true,
      onchain: { loan_hash, model_id: model, request_sha256, response_body, signature, signer: SIGNER },
      tries: 1,
    });
  }
  return {
    note: "Synthetic test set, not a real TEE verdict set.", model, contract_id: contract, binding, signed_at_ms: signedAt, expires_at_ms: expires,
    attestation: { nonce: sha("synthetic nonce"), checked_at: new Date(signedAt).toISOString(), signers: [{ signing_algo: "ecdsa", signing_address: SIGNER }], sections: [{ name: "synthetic", checks: [{ name: "synthetic check", pass: true }] }], report_sha256: REPORT_SHA },
    results,
  };
}
