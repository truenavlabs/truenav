// Recorded attestation evidence: the snapshot written from `npm run verify:fingerprints` (OutLayer TDX quotes) and
// `npm run verify:attestation` (NEAR AI Cloud report). Same pattern as web/data/recorded/judge-replay.json: a committed
// file with a generated-at time and commit that sit outside its evidence_hash. No network, no keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { canonical } from "../../judge/lib.mjs";
import { parseFingerprintOutput, parseAttestationOutput, buildSnapshot, snapshotHash, SNAPSHOT_SCHEMA, PROVES, NOT_PROVES } from "../record-attestation-evidence.mjs";
import { lastVerifiedLine } from "../../web/src/content/attestation-evidence.ts";

const ROOT = new URL("../../", import.meta.url);
// Whether this checkout has the history to resolve the snapshot's commit. A shallow clone (CI) or a tarball has not, and
// git then exits 128 for a commit that is real. In both cases the commit is still checked as a 40 hex sha below, and
// the history check is reported as skipped with the reason. A full clone that lacks the commit still fails.
const gitIn = (...a) => spawnSync("git", a, { cwd: fileURLToPath(ROOT), encoding: "utf8" });
const topLevel = gitIn("rev-parse", "--show-toplevel");
const isOwnCheckout = topLevel.status === 0 && realpathSync(topLevel.stdout.trim()) === realpathSync(fileURLToPath(ROOT));
const isShallow = isOwnCheckout && gitIn("rev-parse", "--is-shallow-repository").stdout.trim() === "true";
const NO_HISTORY = !isOwnCheckout ? "not a git checkout (a tarball or a copy): no history to read" : isShallow ? "shallow clone: the snapshot's commit may be outside the fetched history" : false;
const read = (p) => readFileSync(new URL(p, ROOT), "utf8");
const json = (p) => JSON.parse(read(p));
const FP_OUT = read("tee/test/fixtures/verify-fingerprints.out.txt");
const ATT_OUT = read("tee/test/fixtures/verify-attestation.out.txt");
const COMMIT = "9c833c8b0e7a4d9ad9f7b2a9c3f1c6b6d1c2a3b4";
const base = (over = {}) => ({ fingerprintOut: FP_OUT, attestationOut: ATT_OUT, fingerprintExit: 0, attestationExit: 0, commit: COMMIT, treeClean: true, generatedAt: "2026-11-14T12:00:00.000Z", wallMs: 4321, node: "v24.0.0", root: ROOT, ...over });

test("parses the fingerprint check output: 17 passing records, 17 quotes, 129 approved measurement sets, 19 loans", () => {
  const p = parseFingerprintOutput(FP_OUT);
  assert.equal(p.records.length, 17);
  assert.ok(p.records.every((r) => r.pass && /^[A-Z0-9-]+$/.test(r.document_id) && /^[0-9a-f]{16}$/.test(r.loan_hash_prefix)));
  assert.deepEqual({ quotes: p.distinctQuotes, approved: p.approvedSets, loans: p.loansChecked, loansOk: p.loansOk, final: p.finalOk }, { quotes: 17, approved: 129, loans: 19, loansOk: true, final: true });
});

test("parses the attestation check output: sections, every check, contract, nonce prefix, capture time, verdict count", () => {
  const p = parseAttestationOutput(ATT_OUT);
  assert.equal(p.contract, "registry.tnlab-368aa2.testnet");
  assert.equal(p.recordedSet, "tee/fixtures/verdicts-368aa2.json");
  assert.match(p.capturedAt, /^2026-11-11T19:15:10\.859Z$/);
  assert.equal(p.verdictsSigned, 19);
  assert.equal(p.checks.length, 19);
  assert.ok(p.checks.every((c) => c.pass));
  assert.deepEqual([...new Set(p.checks.map((c) => c.section))], [null, "NEAR AI Cloud gateway", "Model Qwen/Qwen3-VL-30B-A3B-Instruct"]);
  assert.equal(p.signer, "0x2665cce942fa427ef30d87f4b0bff67fb7645462");
  assert.equal(p.finalOk, true);
});

test("buildSnapshot refuses to record anything that did not fully pass", () => {
  const bad = (over, re) => assert.throws(() => buildSnapshot(base(over)), re);
  bad({ fingerprintOut: FP_OUT.replace("PASS TITLE-DEMO-HRE03", "FAIL TITLE-DEMO-HRE03") }, /fingerprint/i);
  bad({ fingerprintExit: 1 }, /exit/i);
  bad({ attestationExit: 2 }, /exit/i);
  bad({ attestationOut: ATT_OUT.replace("PASS   TDX debug mode off", "FAIL   TDX debug mode off") }, /attestation/i);
  bad({ attestationOut: ATT_OUT.replace(/Attestation checks passed:.*/, "Attestation NOT verified.") }, /attestation/i);
  bad({ fingerprintOut: FP_OUT.split("\n").filter((l) => !l.includes("TITLE-DEMO-MRE02")).join("\n") }, /records/i);
  bad({ fingerprintOut: FP_OUT.replace("17 distinct TDX quotes", "16 distinct TDX quotes") }, /quotes/i);
  bad({ commit: "nothex" }, /commit/i);
});

test("the snapshot ties every record to tee/fixtures/fingerprints.json and recomputes the report hash from the file", () => {
  const s = buildSnapshot(base());
  const fp = json("tee/fixtures/fingerprints.json");
  assert.equal(s.outlayer.records.length, fp.records.length);
  for (const [i, r] of s.outlayer.records.entries()) {
    assert.equal(r.loan_hash, fp.records[i].loan_hash);
    assert.equal(r.call_id, fp.records[i].call_id);
    assert.equal(r.proof_url, `${fp.api}/attestations/by-call/${fp.records[i].call_id}`);
  }
  const raw = Buffer.from(read("tee/fixtures/attestation-report-368aa2.json.b64").replace(/\s+/g, ""), "base64");
  assert.equal(s.near_ai.report_sha256, createHash("sha256").update(raw).digest("hex"));
  assert.equal(s.near_ai.nonce, json("tee/fixtures/verdicts-368aa2.json").attestation.nonce);
  assert.throws(() => buildSnapshot(base({ attestationOut: ATT_OUT.replace("05d451cc07311890", "0000000000000000") })), /report/i);
});

test("evidence_hash covers the evidence and ignores only the generated-at time, wall time and node version", () => {
  const a = buildSnapshot(base());
  const b = buildSnapshot(base({ generatedAt: "2026-11-14T13:30:00.000Z", wallMs: 99, node: "v22.0.0" }));
  assert.equal(a.evidence_hash, b.evidence_hash);
  assert.notEqual(a.ephemeral.generated_at, b.ephemeral.generated_at);
  const c = buildSnapshot(base({ commit: "1".repeat(40) }));
  assert.notEqual(a.evidence_hash, c.evidence_hash);
  const t = structuredClone(a);
  t.near_ai.checks[0].pass = false;
  assert.notEqual(snapshotHash(t), a.evidence_hash);
});

test("the committed snapshot matches its own hash, its commit, the recorded files and the check commands", () => {
  const s = json("web/data/recorded/attestation-evidence.json");
  assert.equal(s.schema, SNAPSHOT_SCHEMA);
  assert.equal(s.ok, true);
  const { ephemeral, evidence_hash, ...hashed } = s;
  assert.equal(evidence_hash, createHash("sha256").update(canonical(hashed)).digest("hex"));
  assert.equal(snapshotHash(s), evidence_hash);
  assert.match(s.commit, /^[0-9a-f]{40}$/);
  assert.match(ephemeral.generated_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.ok(Date.parse(ephemeral.generated_at) <= Date.now(), "generated in the future");
  assert.deepEqual(s.commands, ["npm run verify:fingerprints", "npm run verify:attestation"]);
  const fp = json("tee/fixtures/fingerprints.json");
  assert.deepEqual(s.outlayer.records.map((r) => [r.document_id, r.loan_hash, r.call_id, r.pass]), fp.records.map((r) => [r.document_id, r.loan_hash, r.call_id, true]));
  assert.equal(s.outlayer.distinct_quotes, 17);
  assert.equal(s.outlayer.approved_measurement_sets, 129);
  assert.equal(s.outlayer.wasm_sha256, fp.wasm_sha256);
  const raw = Buffer.from(read("tee/fixtures/attestation-report-368aa2.json.b64").replace(/\s+/g, ""), "base64");
  assert.equal(s.near_ai.report_sha256, createHash("sha256").update(raw).digest("hex"));
  assert.equal(s.near_ai.report_sha256, json("tee/fixtures/verdicts-368aa2.json").attestation.report_sha256);
  assert.ok(s.near_ai.checks.length >= 15 && s.near_ai.checks.every((c) => c.pass === true));
  assert.equal(s.near_ai.verdicts_signed, json("tee/fixtures/verdicts-368aa2.json").results.length);
});

test("the snapshot's commit is in this repository's history", { skip: NO_HISTORY }, () => {
  const s = json("web/data/recorded/attestation-evidence.json");
  const g = gitIn("cat-file", "-e", `${s.commit}^{commit}`);
  assert.equal(g.status, 0, `the snapshot's commit ${s.commit} is not in this repository's history`);
});

test("every check label recorded for a fingerprint run exists in the code that runs it", () => {
  const code = read("tee/fingerprint.mjs") + read("tee/verify-fingerprints.mjs");
  const s = json("web/data/recorded/attestation-evidence.json");
  assert.ok(s.outlayer.checks_per_record.length >= 8);
  for (const label of s.outlayer.checks_per_record) assert.ok(code.includes(label), `not in tee/fingerprint.mjs or tee/verify-fingerprints.mjs: ${label}`);
});

test("it never claims more than the checks prove: the statements are fixed text, and the limits are stated", () => {
  const s = json("web/data/recorded/attestation-evidence.json");
  assert.deepEqual(s.proves, PROVES);
  assert.deepEqual(s.not_proves, NOT_PROVES);
  const all = JSON.stringify([s.proves, s.not_proves, lastVerifiedLine(s)]);
  assert.doesNotMatch(all, /guarantee|trustless|zero.knowledge|tamper.proof|unhackable|fully verified|certified|proves (the )?(model|underwriter) (is|was) correct/i);
  const np = s.not_proves.join(" ");
  for (const must of ["judgment", "MRTD", "NVIDIA", "TLS", "prompt", "recorded run", "hardware", "earlier OutLayer project"]) assert.ok(np.includes(must), `not_proves does not mention ${must}`);
  for (const must of ["Intel", "approved", "nonce", "19 recorded verdicts"]) assert.ok(s.proves.join(" ").includes(must), `proves does not mention ${must}`);
  assert.doesNotMatch(JSON.stringify(s), /[\u2013\u2014]/);
});

test("lastVerifiedLine names the Bangkok and UTC time, the commit and that this is a recorded run", () => {
  const s = json("web/data/recorded/attestation-evidence.json");
  const line = lastVerifiedLine(s);
  assert.match(line, /^Last verified \d{1,2} [A-Z][a-z]{2} \d\d:\d\d Bangkok \(\d{1,2} [A-Z][a-z]{2} \d\d:\d\d UTC\)/);
  assert.ok(line.includes(s.commit.slice(0, 7)));
  assert.match(line, /recorded run/i);
  const fixed = lastVerifiedLine({ ...s, ephemeral: { ...s.ephemeral, generated_at: "2026-11-14T11:55:30.000Z" } });
  assert.match(fixed, /^Last verified 14 Nov 18:55 Bangkok \(14 Nov 11:55 UTC\)/);
  assert.throws(() => lastVerifiedLine({ ...s, ephemeral: { generated_at: "not a date" } }));
});
