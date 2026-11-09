// The fingerprint verifier (owner decision D1; 7 Nov audit fixes): a real OutLayer attestation of one demo
// fingerprint run must bind its TDX quote's report_data to the run's wasm, input, output, caller and project, and any
// edit to the record or the attestation must fail a check. Offline: no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { taskHash, quoteFields, checkFingerprint, isCanonicalId, fingerprint, FP_WASM_SHA256 } from "../fingerprint.mjs";

const att = JSON.parse(readFileSync(new URL("../fixtures/fingerprint-attestation-sample.json", import.meta.url), "utf8"));
const rec = JSON.parse(readFileSync(new URL("../fixtures/fingerprints.json", import.meta.url), "utf8")).records.find((r) => r.call_id === att.call_id);
const failing = async (r, a) => (await checkFingerprint(r, a)).filter(([ok]) => !ok).map(([, l]) => l);

test("the real attestation: report_data is the task hash, and every check passes", async () => {
  assert.ok(rec, "sample attestation belongs to a recorded fingerprint");
  assert.equal(quoteFields(Buffer.from(att.tdx_quote, "base64")).report_data, taskHash(att) + "0".repeat(64));
  assert.equal(att.wasm_hash, FP_WASM_SHA256);
  assert.deepEqual(await failing(rec, att), []);
});

test("an attestation edited after the fact no longer matches its quote", async () => {
  for (const k of ["output_hash", "input_hash", "wasm_hash", "caller_account_id", "project_id"]) {
    const edited = { ...att, [k]: k.endsWith("hash") ? "0".repeat(64) : "mallory.testnet" };
    assert.ok((await failing(rec, edited)).some((l) => l.includes("report_data")), k);
  }
});

test("a record whose loan_hash or input differs from the attested run fails", async () => {
  assert.ok((await failing({ ...rec, loan_hash: "f".repeat(64), output: rec.output.replace(rec.loan_hash, "f".repeat(64)) }, att)).some((l) => l.includes("output")));
  assert.ok((await failing({ ...rec, input: rec.input.replace(rec.document_id, "TITLE-DEMO-OTHER") }, att)).some((l) => l.includes("input")));
});

test("the HTTPS call pins version_key to the fingerprint wasm", async () => {
  const seen = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    seen.push(JSON.parse(opts.body));
    return { ok: true, async json() { return { output: { loan_hash: "ab".repeat(32) }, call_id: "c1" }; } };
  };
  try {
    await fingerprint("real_estate", "TITLE-1", "county-a", "payment-key");
    await fingerprint("real_estate", "Ab-1", "Deeds", "payment-key", true);
  } finally {
    globalThis.fetch = prev;
  }
  assert.equal(seen[0].version_key, FP_WASM_SHA256);
  assert.equal(seen[0].input.collateral_namespace, "county-a");
  assert.equal(seen[0].input.case_sensitive, false);
  assert.equal(seen[1].version_key, FP_WASM_SHA256);
  assert.equal(seen[1].input.collateral_namespace, "Deeds");
  assert.equal(seen[1].input.document_id, "Ab-1");
  assert.equal(seen[1].input.case_sensitive, true);
});

test("only canonical document ids are accepted", () => {
  for (const ok of ["TITLE-DEMO-HRE01", "INV-123", "A"]) assert.ok(isCanonicalId(ok), ok);
  for (const bad of [" INV-123", "inv-123", "INV 123", "INV|1", "", "-INV", "X".repeat(129)]) assert.ok(!isCanonicalId(bad), JSON.stringify(bad));
});
