// RT3-01: taskHash has no field framing. A forged body can share a quote with a different
// wasm and output if repo, commit or secrets_ref absorb the pinned block. Simulated quote
// capability only; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { matchWithCapabilities, bodyOf, canonical, sha } from "../../receipts/attestation/match-core.mjs";
import { taskHash, quoteFields, checkFingerprint, framingOk, FP_WASM_SHA256, FP_PROJECT, FP_CALLER } from "../../tee/fingerprint.mjs";

const read = (p) => JSON.parse(fs.readFileSync(new URL("../../" + p, import.meta.url)));
const shaS = (s) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
const ATTACKER_WASM = "f".repeat(64);
const ATTACKER_OUT = "e".repeat(64);

// Real job the attacker runs in a genuine worker: its commit field carries the pinned block.
function splice(forged) {
  const payload = forged.build_target + forged.wasm_hash + forged.input_hash + forged.output_hash + forged.caller_account_id + forged.project_id;
  const real = {
    task_type: "execute", task_id: forged.task_id, repo: "github.com/attacker/x", commit: payload,
    build_target: "wasm32-wasip2", wasm_hash: ATTACKER_WASM, input_hash: "d".repeat(64), output_hash: ATTACKER_OUT,
    caller_account_id: "attacker.testnet", project_id: "attacker.testnet/p",
    timestamp: forged.timestamp, attached_usd: forged.attached_usd,
  };
  // The served proof's secrets_ref absorbs the real job's tail.
  forged.repo = "github.com/attacker/x";
  forged.secrets_ref = real.build_target + real.wasm_hash + real.input_hash + real.output_hash + real.caller_account_id + real.project_id;
  delete forged.block_height;
  return real;
}

test("RT3-01 two proofs, different wasm_hash and output, same taskHash", () => {
  const forged = { task_type: "execute", task_id: 7, build_target: "wasm32-wasip2", wasm_hash: "a".repeat(64), input_hash: "b".repeat(64), output_hash: "c".repeat(64), caller_account_id: "receipts.tnlab-718ca9.testnet", project_id: "receipts.tnlab-718ca9.testnet/truenav-engine", timestamp: 1, attached_usd: "0" };
  const real = splice(forged);
  assert.notEqual(real.wasm_hash, forged.wasm_hash);
  assert.equal(taskHash(real), taskHash(forged));
});

test("RT3-01 matcher must not attest a forged body", async () => {
  const e = structuredClone(read("schema/vectors/engine-v3-derived.json").vectors[0].envelope);
  const realSample = read("tee/fixtures/fingerprint-attestation-sample.json");
  const m = quoteFields(Buffer.from(realSample.tdx_quote, "base64"));
  const forged = {
    task_type: "execute", task_id: 25434, build_target: "wasm32-wasip2", wasm_hash: e.engine_code_sha256, executed_wasm_sha256: e.engine_code_sha256,
    input_hash: "1".repeat(64), output_hash: sha(canonical(bodyOf(e))), caller_account_id: "receipts.tnlab-718ca9.testnet", project_id: "receipts.tnlab-718ca9.testnet/truenav-engine",
    timestamp: Math.floor(Date.parse(e.valuation_time) / 1000), attached_usd: "0", tdx_quote: realSample.tdx_quote,
  };
  const real = splice(forged);
  // A genuine worker quote signs REPORTDATA over the real job, not the served proof.
  const caps = { fetchProof: async () => forged, quoteFields: () => ({ ...m, report_data: taskHash(real) + "0".repeat(64) }), verifyQuote: async () => ({ status: "UpToDate" }) };
  const r = { token_id: e.token_id, seq: e.seq, receipt_sha256: e.receipt_sha256, body_sha256: forged.output_hash, proof_ref: "https://testnet-api.outlayer.ai/attestations/by-request/1", proof_scheme: "outlayer_tdx_v1", attester: "relayer.testnet", block_height: "100" };
  const c = { engine_code_sha256: e.engine_code_sha256, input_hash: forged.input_hash, caller_account_id: forged.caller_account_id, project_id: forged.project_id, fund_id: e.fund_id, approved_measurements: [m] };
  const out = await matchWithCapabilities({ envelope: e, record: r, context: c }, caps);
  assert.notEqual(out.status, "attested");
});

test("RT3-01 checkFingerprint must not PASS a spliced proof", async () => {
  const sample = read("tee/fixtures/fingerprint-attestation-sample.json");
  const input = JSON.stringify({ asset_type: "invoices", collateral_namespace: "demo", document_id: "INV-FORGED-1", nonce: "00", case_sensitive: false });
  const output = JSON.stringify({ loan_hash: "9".repeat(64), domain: "truenav-fp-v4" });
  const rec = { asset_type: "invoices", document_id: "INV-FORGED-1", loan_hash: "9".repeat(64), input, output };
  const forged = {
    task_type: "execute", task_id: sample.task_id, build_target: "wasm32-wasip2", wasm_hash: FP_WASM_SHA256, executed_wasm_sha256: FP_WASM_SHA256,
    input_hash: shaS(input), output_hash: shaS(output), caller_account_id: FP_CALLER, project_id: FP_PROJECT, timestamp: sample.timestamp, attached_usd: "0",
  };
  const real = splice(forged);
  const q = Buffer.from(sample.tdx_quote, "base64");
  Buffer.from(taskHash(real) + "0".repeat(64), "hex").copy(q, 568); // synthetic: quote REPORTDATA over the real job
  forged.tdx_quote = q.toString("base64");
  const lines = await checkFingerprint(rec, forged);
  assert.ok(lines.some(([ok]) => !ok), "every line passed for a forged loan_hash");
});

test("RT3-01 variant: served proof repo absorbs the real prefix, real secrets_ref carries the pinned block", () => {
  const f = { task_type: "execute", task_id: 9, build_target: "wasm32-wasip2", wasm_hash: "a".repeat(64), input_hash: "b".repeat(64), output_hash: "c".repeat(64), caller_account_id: "receipts.tnlab-718ca9.testnet", project_id: "receipts.tnlab-718ca9.testnet/truenav-engine", timestamp: 1, attached_usd: "0" };
  const real = { task_type: "execute", task_id: 9, build_target: "wasm32-wasip2", wasm_hash: ATTACKER_WASM, input_hash: "d".repeat(64), output_hash: ATTACKER_OUT, caller_account_id: "attacker.testnet", project_id: "attacker.testnet/p", timestamp: 1, attached_usd: "0" };
  real.secrets_ref = f.build_target + f.wasm_hash + f.input_hash + f.output_hash + f.caller_account_id + f.project_id;
  f.repo = real.build_target + real.wasm_hash + real.input_hash + real.output_hash + real.caller_account_id + real.project_id;
  assert.equal(taskHash(real), taskHash(f));
});

const base = { attached_usd: "0" };

test("RT3-01 framingOk rejects repo or commit and requires a numeric attached_usd string", () => {
  assert.equal(framingOk(base), true);
  assert.equal(framingOk({ ...base, repo: "github.com/attacker/x" }), false);
  assert.equal(framingOk({ ...base, commit: "abc" }), false);
  assert.equal(framingOk({ attached_usd: 0 }), false);
  assert.equal(framingOk({ attached_usd: "0.5" }), true);
  assert.equal(framingOk({ attached_usd: "1e6" }), false);
  assert.equal(framingOk({ attached_usd: "-1" }), false);
});

test("RT3-01 framingOk allows a short bounded secrets_ref and rejects a hash-sized or overlong one", () => {
  assert.equal(framingOk({ ...base, secrets_ref: "TEST" }), true);
  assert.equal(framingOk({ ...base, secrets_ref: '{"profile":"TEST","account_id":"receipts.tnlab-718ca9.testnet"}' }), true);
  assert.equal(framingOk({ ...base, secrets_ref: "a".repeat(64) }), false);
  assert.equal(framingOk({ ...base, secrets_ref: "x".repeat(129) }), false);
  assert.equal(framingOk({ ...base, secrets_ref: "ok" }, { secrets_ref: "ok" }), true);
  assert.equal(framingOk({ ...base, secrets_ref: "ok" }, { secrets_ref: "other" }), false);
});

test("RT3-01 recorded fingerprint proof still frames and verifies", async () => {
  const att = read("tee/fixtures/fingerprint-attestation-sample.json");
  const recs = read("tee/fixtures/fingerprints.json").records;
  const rec = recs.find((r) => r.call_id === att.call_id);
  assert.ok(rec);
  assert.equal(framingOk(att), true);
  assert.ok(!("repo" in att) && !("commit" in att) && !("secrets_ref" in att));
  assert.equal(att.attached_usd, "0");
  const lines = await checkFingerprint(rec, att);
  assert.deepEqual(lines.filter(([ok]) => !ok), []);
});
