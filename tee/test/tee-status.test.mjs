// tee/status.json is the one switch from TEE "pending" to "live". These tests cover the committed state and, with a
// synthetic set in a temporary tree, the live state. No network, no key, no chain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { signEip191, addressOf } from "../../certify/certificate.mjs";
import { bindingFor, VERDICT_TTL_MS } from "../underwrite.mjs";
import { readStatus, checkStatus, renderStatusDoc, stalePendingClaims, DOC_FILE, STATUS_FILE, PENDING_PHRASES } from "../status.mjs";

const REPO = new URL("../../", import.meta.url);
const REGISTRY = "registry.tnlab-368aa2.testnet";
const sha = (s) => createHash("sha256").update(s).digest("hex");

test("the committed status is valid and docs/TEE_STATUS.md is exactly what it renders", () => {
  const status = readStatus(REPO);
  const { problems, verdicts } = checkStatus(status, { root: REPO });
  assert.deepEqual(problems, []);
  assert.equal(readFileSync(new URL(DOC_FILE, REPO), "utf8"), renderStatusDoc(status, verdicts), `${DOC_FILE} is stale: run npm run tee:status -- --write`);
  assert.equal(status.registry, REGISTRY);
  // the doc and the hand-written docs agree on the state
  if (status.tee === "live") assert.deepEqual(stalePendingClaims(REPO), [], "a live status must not leave TEE pending claims in the docs");
});

test("a pending status must not name files; unknown keys and bad values are refused", () => {
  const ok = { registry: REGISTRY, tee: "pending", verdicts_file: null, report_file: null, earlier_instance: "registry.tnlab-718ca9.testnet" };
  assert.deepEqual(checkStatus(ok, { root: REPO }).problems, []);
  assert.ok(checkStatus({ ...ok, verdicts_file: "tee/fixtures/verdicts-368aa2.json" }, { root: REPO }).problems.some((p) => p.includes("pending status must have verdicts_file")));
  assert.ok(checkStatus({ ...ok, extra: 1 }, { root: REPO }).problems.some((p) => p.includes("unknown key extra")));
  assert.ok(checkStatus({ ...ok, tee: "maybe" }, { root: REPO }).problems.some((p) => p.includes('"pending" or "live"')));
  assert.ok(checkStatus({ ...ok, registry: "nope" }, { root: REPO }).problems.some((p) => p.includes("registry must be")));
});

// ---- a live status in a temporary tree, with a synthetic signed set ----------------------------------------------
const KEY = Uint8Array.from(createHash("sha256").update("truenav synthetic status test, not a real signer").digest());
const SIGNER = addressOf(KEY).toLowerCase();
const SIGNED_AT = Date.now() - 86400000;

function liveTree({ report = "synthetic attestation report", recordedReport = report } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "truenav-status-"));
  mkdirSync(join(dir, "tee/fixtures"), { recursive: true });
  const expires = SIGNED_AT + VERDICT_TTL_MS;
  const binding = bindingFor(REGISTRY, expires);
  const model = "synthetic/test-model";
  const loan_hash = sha("synthetic loan");
  const reply = { loan_hash: loan_hash.match(/.{8}/g).join(" "), binding, id_mismatch: "ok", asset_mismatch: "ok", amount_mismatch: "ok", duplicate_document: "ok", duplicate_evidence_line: "ok", injection_attempt: "ok", unreadable: "ok", verdict: "pass", anomalies: [] };
  const response_body = JSON.stringify({ id: "chatcmpl-synthetic", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(reply) }, finish_reason: "stop", logprobs: null }], model });
  const request_sha256 = sha("synthetic request");
  const set = {
    note: "Synthetic test set.", model, contract_id: REGISTRY, binding, signed_at_ms: SIGNED_AT, expires_at_ms: expires,
    attestation: { nonce: sha("n"), checked_at: new Date(SIGNED_AT).toISOString(), signers: [{ signing_algo: "ecdsa", signing_address: SIGNER }], sections: [{ name: "synthetic", checks: [{ check: "c", pass: true, detail: "" }] }], report_sha256: sha(recordedReport) },
    results: [{
      loan_id: "S-0", fund_id: "f", loan_hash, tampered: null,
      verdict: { loan_hash, binding, verdict: "pass", anomalies: [], duplicate_evidence_line: "ok" },
      checks: { signature_kind_provider_tee: true, text_matches_exact_bytes: true, recovered_equals_signing_address: true, signer_attested_with_fresh_nonce: true, verdict_bound_to_loan_hash: true, binding_echoed_exactly: true, reply_keys_allowed: true },
      ok: true,
      onchain: { loan_hash, model_id: model, request_sha256, response_body, signature: signEip191(`${model}:${request_sha256}:${sha(response_body)}`, KEY), signer: SIGNER },
      tries: 1,
    }],
  };
  writeFileSync(join(dir, "tee/fixtures/verdicts-368aa2.json"), JSON.stringify(set));
  // the report file is stored base64 with line breaks, like the real one
  writeFileSync(join(dir, "tee/fixtures/attestation-report-368aa2.json.b64"), Buffer.from(report).toString("base64").replace(/.{20}/g, "$&\n") + "\n");
  return { dir, root: pathToFileURL(dir + "/") };
}
const live = { registry: REGISTRY, tee: "live", verdicts_file: "tee/fixtures/verdicts-368aa2.json", report_file: "tee/fixtures/attestation-report-368aa2.json.b64", earlier_instance: "registry.tnlab-718ca9.testnet" };

test("a live status with a valid set and its matching report has no problems and renders the live doc", () => {
  const { dir, root } = liveTree();
  try {
    const { problems, verdicts } = checkStatus(live, { root });
    assert.deepEqual(problems, []);
    assert.equal(verdicts.records, 1);
    assert.equal(verdicts.pass, 1);
    const doc = renderStatusDoc(live, verdicts);
    assert.match(doc, /TEE status: \*\*live\*\*/);
    assert.match(doc, new RegExp(SIGNER));
    assert.match(doc, /1 records \(1 pass, 0 flag\)/);
    assert.match(doc, new RegExp(`TRUENAV_CONTRACT=${REGISTRY} npm run chain:read`));
    assert.doesNotMatch(doc, /\*\*pending\*\*/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a live status is refused when a file is missing, the set is for another registry, or the report hash differs", () => {
  const { dir, root } = liveTree({ report: "the report we publish", recordedReport: "a different report" });
  try {
    assert.ok(checkStatus(live, { root }).problems.some((p) => p.includes("has sha256") && p.includes("records")), "report hash mismatch");
    assert.ok(checkStatus({ ...live, verdicts_file: "tee/fixtures/nope.json" }, { root }).problems.some((p) => p.includes("does not exist")));
    assert.ok(checkStatus({ ...live, registry: "registry.other.testnet" }, { root }).problems.some((p) => p.includes("expected registry.other.testnet")));
    assert.ok(checkStatus({ ...live, verdicts_file: "tee/fixtures/verdicts.json", report_file: "tee/fixtures/attestation-report.json.b64" }, { root: REPO }).problems.some((p) => p.includes("earlier instance")));
    assert.ok(checkStatus({ ...live, verdicts_file: "../outside.json" }, { root }).problems.some((p) => p.includes("path inside the repository")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hand-written docs that still say TEE is pending are found (README.md, TRUST_MODEL.md, ARCHITECTURE.md)", () => {
  const dir = mkdtempSync(join(tmpdir(), "truenav-status-docs-"));
  try {
    writeFileSync(join(dir, "README.md"), "Intro\nThe registry shows TEE verdicts pending (11 Harbor).\nok line\n");
    writeFileSync(join(dir, "TRUST_MODEL.md"), "TEE is live here.\n");
    const hits = stalePendingClaims(pathToFileURL(dir + "/"));
    assert.deepEqual(hits.map((h) => `${h.file}:${h.line}`), ["README.md:2"]);
    assert.ok(PENDING_PHRASES.includes(hits[0].phrase));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(STATUS_FILE, "tee/status.json");
});
