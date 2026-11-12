// The verdicts-file validator (tee/verdicts-file.mjs) and the contract target of tee/underwrite.mjs. No network, no
// NEAR AI Cloud key: the synthetic set is signed here with a throwaway key derived from a label, never a real signer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { signEip191, addressOf } from "../../certify/certificate.mjs";
import { bindingFor, VERDICT_TTL_MS, resolveContract, DEFAULT_CONTRACT_ID } from "../underwrite.mjs";
import { validateVerdictsFile } from "../verdicts-file.mjs";

const REGISTRY = "registry.tnlab-368aa2.testnet";
const sha = (s) => createHash("sha256").update(s).digest("hex");
const KEY = Uint8Array.from(createHash("sha256").update("truenav synthetic verdict-set test, not a real signer").digest());
const SIGNER = addressOf(KEY).toLowerCase();
const SIGNED_AT = Date.parse("2026-11-12T00:00:00Z");
const group = (h) => h.match(/.{8}/g).join(" ");

/** A complete, validly signed verdicts file for `contract`, using the exact shape tee/underwrite.mjs writes. */
function syntheticSet({ contract = REGISTRY, signedAt = SIGNED_AT, n = 3, model = "synthetic/test-model" } = {}) {
  const expires = signedAt + VERDICT_TTL_MS;
  const binding = bindingFor(contract, expires);
  const results = [];
  for (let i = 0; i < n; i++) {
    const tampered = i === n - 1 ? { id: "T1-altered-amount", expected_anomaly: "amount_mismatch" } : null;
    const loan_hash = sha(`synthetic loan ${i}`);
    const verdict = tampered ? "flag" : "pass";
    const anomalies = tampered ? ["amount_mismatch"] : [];
    const reply = { loan_hash: group(loan_hash), binding, id_mismatch: "ok", asset_mismatch: "ok", amount_mismatch: tampered ? "fail" : "ok", duplicate_document: "ok", duplicate_evidence_line: "ok", injection_attempt: "ok", unreadable: "ok", verdict, anomalies };
    const response_body = JSON.stringify({ id: `chatcmpl-synthetic-${i}`, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(reply) }, finish_reason: "stop", logprobs: null }], model });
    const request_sha256 = sha(`synthetic request ${i}`);
    const signature = signEip191(`${model}:${request_sha256}:${sha(response_body)}`, KEY);
    results.push({
      loan_id: `S-${i}`, fund_id: "synthetic-fund", loan_hash, tampered,
      verdict: { loan_hash, binding, verdict, anomalies, duplicate_evidence_line: "ok" },
      checks: { signature_kind_provider_tee: true, text_matches_exact_bytes: true, recovered_equals_signing_address: true, signer_attested_with_fresh_nonce: true, verdict_bound_to_loan_hash: true, binding_echoed_exactly: true, reply_keys_allowed: true },
      ok: true,
      onchain: { loan_hash, model_id: model, request_sha256, response_body, signature, signer: SIGNER },
      tries: 1,
    });
  }
  return {
    note: "Synthetic test set, not a real TEE verdict set.", model, contract_id: contract, binding, signed_at_ms: signedAt, expires_at_ms: expires,
    attestation: { nonce: sha("synthetic nonce"), checked_at: new Date(signedAt).toISOString(), signers: [{ signing_algo: "ecdsa", signing_address: SIGNER }], sections: [{ name: "synthetic", checks: [{ check: "synthetic check", pass: true, detail: "" }] }], report_sha256: sha("synthetic report") },
    results,
  };
}
const clone = (x) => structuredClone(x);
const NOW = SIGNED_AT + 86400000;
const check = (file, o = {}) => validateVerdictsFile(file, { contract: REGISTRY, nowMs: NOW, minDays: 10, ...o });
const has = (r, text) => r.problems.some((p) => p.includes(text));

test("a synthetic set for the 368aa2 registry validates with no real file", () => {
  const r = check(syntheticSet());
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
  assert.equal(r.records, 3);
  assert.equal(r.signer, SIGNER);
  assert.equal(r.expires_at_ms, SIGNED_AT + VERDICT_TTL_MS);
});

test("the recorded sets in the repository validate against their own contract", () => {
  for (const f of ["tee/fixtures/verdicts.json", "tee/fixtures/verdicts-unit.json"]) {
    const file = JSON.parse(readFileSync(new URL(`../../${f}`, import.meta.url), "utf8"));
    const r = validateVerdictsFile(file, { contract: file.contract_id });
    assert.deepEqual(r.problems, [], f);
    assert.equal(r.records, 19, f);
  }
});

test("tee/fixtures/verdicts-368aa2.json, once it exists, validates for the 368aa2 registry (skipped while it is absent)", { skip: !existsSync(new URL("../fixtures/verdicts-368aa2.json", import.meta.url)) && "no tee/fixtures/verdicts-368aa2.json yet" }, () => {
  const file = JSON.parse(readFileSync(new URL("../fixtures/verdicts-368aa2.json", import.meta.url), "utf8"));
  assert.deepEqual(validateVerdictsFile(file, { contract: REGISTRY }).problems, []);
});

test("a set bound to another registry, with a changed binding, or with a wrong lifetime is refused", () => {
  assert.ok(has(check(syntheticSet({ contract: "registry.tnlab-718ca9.testnet" })), "expected registry.tnlab-368aa2.testnet"));
  const rebound = clone(syntheticSet());
  rebound.binding = bindingFor("registry.tnlab-718ca9.testnet", rebound.expires_at_ms);
  assert.ok(has(check(rebound), "binding must be"));
  const long = clone(syntheticSet());
  long.expires_at_ms += 1;
  assert.ok(has(check(long), "plus 30 days"));
  assert.ok(has(check(syntheticSet(), { nowMs: SIGNED_AT + VERDICT_TTL_MS + 1 }), "expired"));
  assert.ok(has(check(syntheticSet(), { nowMs: SIGNED_AT + VERDICT_TTL_MS - 5 * 86400000 }), "days left (minimum 10)"));
});

test("a changed signature, response, model, request hash or signer is caught by the cryptographic checks", () => {
  const sigProblem = "the signature does not recover";
  let f = clone(syntheticSet());
  f.results[0].onchain.response_body = f.results[0].onchain.response_body.replace("chatcmpl-synthetic-0", "chatcmpl-synthetic-X");
  assert.ok(has(check(f), sigProblem), "response bytes");
  f = clone(syntheticSet());
  f.results[1].onchain.request_sha256 = sha("another request");
  assert.ok(has(check(f), sigProblem), "request hash");
  f = clone(syntheticSet());
  f.model = "synthetic/other-model";
  f.results.forEach((r) => (r.onchain.model_id = "synthetic/other-model"));
  assert.ok(has(check(f), sigProblem), "model");
  f = clone(syntheticSet());
  f.results[0].onchain.signer = "0x" + "11".repeat(20);
  assert.ok(has(check(f), "not an attested signer"), "unattested signer");
  f = clone(syntheticSet());
  f.attestation.signers[0].signing_address = "0x" + "22".repeat(20);
  assert.ok(has(check(f), "not an attested signer"), "attested list changed");
  f = clone(syntheticSet());
  f.results[0].onchain.signature = "0x" + "00".repeat(65);
  assert.equal(check(f).ok, false, "zero signature");
});

test("the reply rule, the named loan and the echoed binding are checked on the signed reply", () => {
  // a reply with an extra key is re-signed here, so only the reply rule can refuse it
  const resign = (f, i, edit) => {
    const r = f.results[i];
    const body = JSON.parse(r.onchain.response_body);
    const reply = JSON.parse(body.choices[0].message.content);
    edit(reply);
    body.choices[0].message.content = JSON.stringify(reply);
    r.onchain.response_body = JSON.stringify(body);
    r.onchain.signature = signEip191(`${f.model}:${r.onchain.request_sha256}:${sha(r.onchain.response_body)}`, KEY);
    return f;
  };
  assert.ok(has(check(resign(clone(syntheticSet()), 0, (r) => (r.tenant_name = "x"))), "reply rule: reply has a key outside the allowed list"));
  assert.ok(has(check(resign(clone(syntheticSet()), 0, (r) => (r.loan_hash = group(sha("other loan"))))), "names another loan_hash"));
  assert.ok(has(check(resign(clone(syntheticSet()), 1, (r) => (r.binding = bindingFor("registry.other.testnet", 1)))), "another binding"));
  assert.ok(has(check(resign(clone(syntheticSet()), 2, (r) => (r.verdict = "pass"))), "verdict does not match the signed reply"));
});

test("structure: missing or malformed fields, unverified records, empty results and mixed signers are refused", () => {
  assert.equal(validateVerdictsFile(null).ok, false);
  assert.equal(validateVerdictsFile([]).ok, false);
  let f = clone(syntheticSet());
  delete f.attestation;
  assert.ok(has(check(f), "attestation must be an object"));
  f = clone(syntheticSet());
  f.results = [];
  assert.ok(has(check(f), "results must be a non-empty array"));
  f = clone(syntheticSet());
  f.results[0].ok = false;
  assert.ok(has(check(f), "ok must be true"));
  f = clone(syntheticSet());
  f.results[0].checks.reply_keys_allowed = false;
  assert.ok(has(check(f), "checks must be exactly"));
  f = clone(syntheticSet());
  f.results[0].loan_hash = "NOT-A-HASH";
  assert.ok(has(check(f), "loan_hash must be 64 lowercase hex"));
  f = clone(syntheticSet());
  f.results[2].tampered = { id: "T9", expected_anomaly: "made_up" };
  assert.ok(has(check(f), "tampered must be null or"));
  f = clone(syntheticSet());
  f.attestation.sections[0].checks[0].pass = false;
  assert.ok(has(check(f), "an attestation check did not pass"));
  f = clone(syntheticSet());
  f.attestation.report_sha256 = "short";
  assert.ok(has(check(f), "report_sha256"));
  f = clone(syntheticSet());
  f.contract_id = "not an account";
  assert.ok(has(check(f, { contract: undefined }), "contract_id must be a testnet or mainnet account id"));
});

test("underwrite.mjs binds to --contract, else TRUENAV_CONTRACT, else the unchanged default", () => {
  assert.equal(DEFAULT_CONTRACT_ID, "registry.test.near");
  assert.equal(resolveContract([], {}), "registry.test.near");
  assert.equal(resolveContract(["--only", "T1"], {}), "registry.test.near");
  assert.equal(resolveContract([], { TRUENAV_CONTRACT: REGISTRY }), REGISTRY);
  assert.equal(resolveContract(["--contract", "registry.x.testnet"], { TRUENAV_CONTRACT: REGISTRY }), "registry.x.testnet");
  assert.throws(() => resolveContract(["--contract"], {}), /needs an account id/);
  assert.throws(() => resolveContract(["--contract", "--out", "f.json"], {}), /needs an account id/);
  assert.equal(bindingFor(REGISTRY, 1796611874623), `truenav-verdict-v1|${REGISTRY}|testnet|1796611874623`);
});
