import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRunRecord, runRecordSummary, teeRunFields } from "./testnet-record.mjs";

const base = {
  network: "testnet",
  rpc: "https://test.rpc.fastnear.com",
  contract_id: "registry.tnlab-368aa2.testnet",
  admin_and_servicer: "tnlab-368aa2.testnet",
  fund_accounts: { "harbor-credit-fund": "harbor.tnlab-368aa2.testnet" },
  signer_address: "0x6994c1391f4244185497aa2afa8e14f5790314b0",
  signer_kind: "test key, not TEE",
  engine_commit: "d837036",
  signed_at_ms: 1,
  double_pledge_loan_hash: "e".repeat(64),
  scores_from_chain: [{ fund_id: "harbor-credit-fund", status: "certified", raw: 99.17, band: "green", tee: { pass: 0, pending: 11, flag: 0, overdue: 0 } }],
  steps: [{ check: "Meridian refused: already pledged elsewhere", pass: true }],
};

test("null tee does not throw, marks TEE pending, and stays JSON-serializable", () => {
  const out = buildRunRecord({ ...base, tee: null, teeSigner: null });
  assert.equal(out.tee_status, "pending");
  assert.equal(out.tee_signer, null);
  assert.equal(out.tee_model, null);
  assert.match(out.tee_reason, /no recorded TEE verdict set for this contract id/);
  assert.match(out.note, /loans stay pending/);
  assert.doesNotMatch(out.note, /loan verdicts are signed by the attested/);
  assert.equal(runRecordSummary({ failed: false, tee: null }), "on-chain checks passed; TEE pending, not run");
  assert.deepEqual(JSON.parse(JSON.stringify(out)), out);
});

test("a recorded tee set is labelled submitted and keeps its model and signer", () => {
  const tee = { model: "near-ai-cloud/demo", contract_id: base.contract_id };
  const out = buildRunRecord({ ...base, tee, teeSigner: "0xabc" });
  assert.equal(out.tee_status, "submitted");
  assert.equal(out.tee_reason, null);
  assert.equal(out.tee_model, "near-ai-cloud/demo");
  assert.equal(out.tee_signer, "0xabc");
  assert.match(out.note, /loan verdicts are signed by the attested NEAR AI Cloud model TEE/);
  assert.equal(runRecordSummary({ failed: false, tee }), "all checks passed");
  assert.equal(runRecordSummary({ failed: true, tee }), "some checks FAILED");
});

test("teeRunFields never invents a signer or model when tee is missing", () => {
  assert.deepEqual(teeRunFields(null, "0xshould-not-appear"), {
    tee_status: "pending",
    tee_reason: "no recorded TEE verdict set for this contract id; loans stay pending",
    tee_signer: null,
    tee_model: null,
  });
});
