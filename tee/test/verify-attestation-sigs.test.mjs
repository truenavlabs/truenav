// NEW-03: verify-attestation must recover each verdict signature against the attested key,
// not just compare onchain.signer labels. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkVerdictSignatures } from "../underwrite.mjs";

const unit = () => JSON.parse(readFileSync(new URL("../fixtures/verdicts-unit.json", import.meta.url), "utf8"));
const attestedOf = (file) => file.attestation.signers[0].signing_address.toLowerCase();

function tamperVerdictBody(file) {
  const out = structuredClone(file);
  const body = JSON.parse(out.results[0].onchain.response_body);
  const reply = JSON.parse(body.choices[0].message.content);
  reply.amount_mismatch = "fail";
  reply.verdict = "flag";
  reply.anomalies = ["amount_mismatch"];
  body.choices[0].message.content = JSON.stringify(reply);
  out.results[0].onchain.response_body = JSON.stringify(body);
  out.results[0].verdict = { ...out.results[0].verdict, verdict: "flag", anomalies: ["amount_mismatch"] };
  return out;
}

test("recorded unit verdicts recover to the attested key", () => {
  const file = unit();
  const r = checkVerdictSignatures(file, attestedOf(file));
  assert.equal(r.ok, true);
  assert.equal(r.count, 19);
  assert.deepEqual(r.problems, []);
});

test("a tampered verdict body with the same signer label fails the signature check", () => {
  const file = unit();
  const attested = attestedOf(file);
  const tampered = tamperVerdictBody(file);
  assert.equal(tampered.results[0].onchain.signer, file.results[0].onchain.signer, "signer label kept");
  assert.equal(tampered.results[0].onchain.signature, file.results[0].onchain.signature, "signature bytes kept");
  const labels = new Set(tampered.results.map((row) => row.onchain.signer.toLowerCase()));
  assert.equal(labels.size === 1 && labels.has(attested), true, "label-only check would still pass");
  const r = checkVerdictSignatures(tampered, attested);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes("signature does not recover to the attested key")));
});

test("a missing signature fails closed", () => {
  const file = unit();
  delete file.results[0].onchain.signature;
  const r = checkVerdictSignatures(file, attestedOf(file));
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes("missing signature")));
});

test("a bad signature fails closed", () => {
  const file = unit();
  file.results[0].onchain.signature = "0x" + "00".repeat(65);
  const r = checkVerdictSignatures(file, attestedOf(file));
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /bad signature|does not recover to the attested key/.test(p)));
});

test("a mismatched attested key fails closed", () => {
  const file = unit();
  const r = checkVerdictSignatures(file, "0x" + "11".repeat(20));
  assert.equal(r.ok, false);
  assert.ok(r.problems.every((p) => p.includes("signature does not recover to the attested key")));
});
