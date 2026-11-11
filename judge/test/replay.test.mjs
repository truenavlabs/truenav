// B05 judge: replay reproducibility and fail-closed guards. Every guard is tested by breaking the thing it guards in
// a throwaway copy of the working tree (OS temp dir, node_modules symlinked) and checking the judge exits non-zero
// with that stage marked fail. A control run on an untouched copy shows the same partial runs pass, so no fail here
// is vacuous. No network, no keys, no Docker.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, symlinkSync, readFileSync, writeFileSync, rmSync, existsSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { canonical, validate, parseAnyReport, parseTap } from "../lib.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = JSON.parse(readFileSync(new URL("../summary.schema.json", import.meta.url), "utf8"));
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

function copyTree() {
  const dir = mkdtempSync(join(tmpdir(), "truenav-judge-copy-"));
  made.push(dir);
  const ls = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(ls.status, 0, ls.stderr);
  for (const f of ls.stdout.split("\0").filter(Boolean)) {
    if (f.startsWith("out/") || !existsSync(join(ROOT, f))) continue;
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    copyFileSync(join(ROOT, f), join(dir, f));
  }
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  return dir;
}
function withCopy(fn) {
  const dir = copyTree();
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    const i = made.indexOf(dir);
    if (i !== -1) made.splice(i, 1);
  }
}
function judge(dir, args, env = {}) {
  rmSync(join(dir, "out/judge-replay.json"), { force: true });
  const r = spawnSync(process.execPath, [join(dir, "judge/run.mjs"), ...args], { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME || tmpdir(), ...env }, timeout: 180_000 });
  const file = join(dir, "out/judge-replay.json");
  return { ...r, summary: existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null };
}
const stage = (s, id) => s.summary.stages.find((x) => x.id === id);
const editJson = (dir, f, edit) => { const p = join(dir, f); const v = JSON.parse(readFileSync(p, "utf8")); edit(v); writeFileSync(p, JSON.stringify(v, null, 2) + "\n"); };
const editText = (dir, f, edit) => { const p = join(dir, f); writeFileSync(p, edit(readFileSync(p, "utf8"))); };
function hashedPart(summary) {
  const { ephemeral, evidence_hash, ...rest } = summary;
  return rest;
}

test("usage errors exit 2: no flag, --with-tests alone, unknown flag, --live, a bad --only, an absolute --out", () => {
  for (const args of [[], ["--with-tests"], ["--replay", "--fast"], ["--live"], ["--replay", "--live"], ["--replay", "--only", "S11"], ["--replay", "--out", "/tmp/x.json"], ["--replay", "--out", "../x.json"]]) {
    const r = spawnSync(process.execPath, [join(ROOT, "judge/run.mjs"), ...args], { encoding: "utf8", env: { PATH: process.env.PATH }, timeout: 20_000 });
    assert.equal(r.status, 2, `${JSON.stringify(args)}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /usage: npm run judge -- --replay/);
  }
});

test("repro: two full replays on a fixture copy exit 0 with the same evidence_hash, with fetch stubbed to throw and network env set", () => {
  withCopy((dir) => {
  const stub = join(dir, "judge-test-fetch-throws.mjs");
  writeFileSync(stub, 'globalThis.fetch = () => { throw new Error("fetch called in replay"); };\n');
  const a = judge(dir, ["--replay"], { NODE_OPTIONS: `--import=${stub}` });
  // a caller's RPC, OutLayer and Base settings must not change a replay (children get a fixed environment)
  const b = judge(dir, ["--replay"], { TRUENAV_RPC: "http://203.0.113.1:3030", BASE_RPC_URL: "http://203.0.113.1:8545", TRUENAV_OUTLAYER_WORKER: "x.testnet" });
  for (const [r, n] of [[a, "stubbed fetch"], [b, "network env"]]) {
    assert.equal(r.status, 0, `${n}: ${r.stdout}${r.stderr}`);
    assert.equal(r.summary.ok, true, n);
    assert.equal(r.summary.partial, false);
    assert.deepEqual(r.summary.stages.map((s) => [s.id, s.status]), [...Array(10)].map((_, i) => [`S${i + 1}`, "pass"]));
    assert.deepEqual(r.summary.skips, []);
    assert.deepEqual(r.summary.offline.refused, []);
    assert.deepEqual(validate(SCHEMA, r.summary), [], n);
    assert.match(r.stdout, /^judge: 10 of 10 stages PASS, 0 skipped not verified, ok true, evidence_hash [0-9a-f]{64}$/m);
  }
  assert.equal(a.summary.evidence_hash, b.summary.evidence_hash, "same commit, same hash");
  assert.equal(a.summary.commit, null, "the temp copy is not a git checkout");
  assert.deepEqual(a.summary.pins, { harbor_raw: 99.17, meridian_raw: 42.84, harbor_score: 99, meridian_score: 43, engine_sha256: JSON.parse(readFileSync(join(ROOT, "receipts/v3-build.json"), "utf8")).engine.sha256 });
  const hashed = canonical(hashedPart(a.summary));
  assert.equal(hashed.includes(dir), false, "no absolute path in hashed fields");
  assert.equal(hashed.includes(tmpdir()), false, "no temp path in hashed fields");
  assert.doesNotMatch(hashed, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no timestamp in hashed fields");
  assert.doesNotMatch(hashed, /days left/, "no remaining-days figure in hashed fields");
  const dash = JSON.parse(readFileSync(join(dir, "out/judge-dashboard.json"), "utf8"));
  assert.equal(dash.label, "data only, no UI");
  assert.deepEqual(dash.funds.map((f) => [f.score, f.band]), [[99, "green"], [43, "red"]]);
  assert.equal(dash.tokens[0].api.error, "run_failed");
  });
});

test("control: the partial runs the guard tests use pass on an untouched copy (partial, ok stays false)", () => {
  withCopy((dir) => {
  const r = judge(dir, ["--replay", "--only", "S1,S2,S3,S4,S6,S9"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.summary.partial, true);
  assert.equal(r.summary.ok, false, "a partial run is never ok");
  assert.deepEqual(r.summary.stages.filter((s) => s.status !== "not_run").map((s) => s.status), Array(6).fill("pass"));
  assert.deepEqual(validate(SCHEMA, r.summary), []);
  });
});

// [name, stages to run, the stage that must fail, edit, evidence pattern]
const CASES = [
  ["missing tee/fixtures/verdicts.json", "S1", "S1", (d) => rmSync(join(d, "tee/fixtures/verdicts.json")), /missing tee\/fixtures\/verdicts\.json/],
  ["a verdict set inside 10 days of expiry", "S1", "S1", (d) => editJson(d, "tee/fixtures/verdicts-unit.json", (v) => { v.expires_at_ms = Date.now() + 5 * 86_400_000; }), /3 of 4 verdict sets/],
  ["a swapped attestation report", "S1", "S1", (d) => editText(d, "tee/fixtures/attestation-report.json.b64", (t) => t.trim() + "AAAA\n"), /attestation report sha256 does not match/],
  ["T1 flipped to a pass", "S2", "S2", (d) => editJson(d, "tee/fixtures/verdicts.json", (v) => { const r = v.results.find((x) => x.tampered?.id === "T1-altered-amount"); r.onchain.response_body = r.onchain.response_body.replace('\\"amount_mismatch\\":\\"fail\\"', '\\"amount_mismatch\\":\\"ok\\"'); }), /T1 not flagged amount_mismatch/],
  ["Harbor's expected raw score edited", "S3", "S3", (d) => editJson(d, "spec/nav/fixtures.json", (v) => { v.funds[0].expected.raw = "99.3"; }), /worked-example field does not match/],
  ["missing receipts/v3-build.json", "S4", "S4", (d) => rmSync(join(d, "receipts/v3-build.json")), /missing receipts\/v3-build\.json/],
  ["a wrong pin in v3-build.json", "S4", "S4", (d) => editJson(d, "receipts/v3-build.json", (v) => { v.engine.sha256 = "dd".repeat(32); }), /declined engine_hash, agent bought 0 \(buys nothing\)/],
  ["the wasm stamp no longer binding the wasm bytes (pre RT2-04)", "S10", "S10", (d) => editText(d, "receipts/e2e/ensure-wasm.mjs", (t) => { const u = t.replace("\\nwasm ${sha256(readFileSync(dest))}", ""); assert.notEqual(u, t, "mutation applied"); return u; }), /not ok: RT2-04 a wasm swapped after stamping reads stale/],
  ["a required paid-report test renamed away", "S6", "S6", (d) => editText(d, "api/test/api.test.mjs", (t) => t.replace('"GET /report without an entitlement is 402 with exactly what to buy"', '"renamed"')), /required test missing: GET \/report without an entitlement is 402/],
  ["a loan hash that is not the recorded fingerprint", "S9", "S9", (d) => editJson(d, "tee/loans.json", (v) => { v.loans[0].loan_hash = "00".repeat(32); }), /loan_hash differs from the recorded fingerprint for H-RE-01/],
  ["an uncaught exception in a stage (unreadable tee/loans.json)", "S9", "S9", (d) => writeFileSync(join(d, "tee/loans.json"), "{not json"), /^uncaught: /],
  ["dashboard data without the stages it is built from", "S7", "S7", () => {}, /needs S3, S4, S5, S6 to pass first/],
  ["a fetch to a public host, even when the script catches the error", "S2", "S2", (d) => appendFileSync(join(d, "tee/demo.mjs"), '\ntry { await fetch("https://rpc.testnet.near.org/"); } catch {}\n'), /network refused in replay \(rpc\.testnet\.near\.org\)/],
  ["a raw https connection to a public host, error swallowed", "S1", "S1", (d) => appendFileSync(join(d, "certify/check-fixtures.mjs"), '\ntry { (await import("node:https")).get("https://example.com/").on("error", () => {}); } catch {}\n'), /network refused in replay \(example\.com\)/],
];

for (const [name, only, failing, edit, pattern] of CASES) {
  test(`fail closed: ${name} fails ${failing} and the judge exits 1`, () => {
    withCopy((dir) => {
    edit(dir);
    const r = judge(dir, ["--replay", "--only", only]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.ok(r.summary, "the summary is still written");
    assert.equal(r.summary.ok, false);
    const s = stage(r, failing);
    assert.equal(s.status, "fail", r.stdout);
    assert.match(s.evidence, pattern);
    assert.match(r.stdout, new RegExp(`^FAIL ${failing} `, "m"));
    assert.deepEqual(validate(SCHEMA, r.summary), []);
    });
  });
}

test("fail closed: the wrong-pin agent probe buys nothing for the committed vector", () => {
  withCopy((dir) => {
  editJson(dir, "receipts/v3-build.json", (v) => { v.engine.sha256 = "dd".repeat(32); });
  const r = spawnSync(process.execPath, [join(dir, "judge/probes/pin-probe.mjs")], { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH }, timeout: 20_000 });
  assert.equal(r.status, 0, r.stderr);
  const p = JSON.parse(r.stdout.trim());
  assert.deepEqual(p.pins, ["dd".repeat(32)]);
  assert.deepEqual(p.committed, { reason: "engine_hash", bought: 0 });
  assert.deepEqual(p.other, { reason: "engine_hash", bought: 0 });
  });
});

test("the summary schema refuses a skip recorded as verified, an unknown stage status and a missing field", () => {
  const base = { schema: "truenav-judge-summary/v1", commit: null, mode: "replay", with_tests: false, partial: false, ok: true, stages: [...Array(10)].map((_, i) => ({ id: `S${i + 1}`, name: "x", status: "pass", claim: "c", evidence: "e", label: null })), pins: { harbor_raw: 99.17, meridian_raw: 42.84, harbor_score: 99, meridian_score: 43, engine_sha256: "ab".repeat(32) }, skips: [], expected: { harbor_raw: 99.17, meridian_raw: 42.84, harbor_score: 99, meridian_score: 43 }, offline: { guard: "judge/no-network.mjs", refused: [] }, ephemeral: { generated_at: "x", fixture_days_left_min: 20, wall_ms: 1, durations_ms: { S1: 1 }, node: "v24" }, evidence_hash: "cd".repeat(32) };
  assert.deepEqual(validate(SCHEMA, base), []);
  assert.notDeepEqual(validate(SCHEMA, { ...base, skips: [{ stage: "TESTS", test: "t", reason: "", status: "verified" }] }), []);
  assert.notDeepEqual(validate(SCHEMA, { ...base, stages: base.stages.map((s, i) => (i ? s : { ...s, status: "skipped" })) }), []);
  const { pins, ...noPins } = base;
  assert.notDeepEqual(validate(SCHEMA, noPins), []);
  assert.notDeepEqual(validate(SCHEMA, { ...base, stages: base.stages.slice(0, 9) }), [], "fewer than 10 stages");
});

test("--with-tests skip parsing names every skip from the spec and TAP reporters, so a skip is never counted as a pass", () => {
  const spec = "\u2714 a (1.2ms)\n\uFE63 python x.test.py (0.6ms) # python3 with jsonschema not found\n\uFE63 OutLayer y (0.5ms) # Rust 1.99.0 cargo not found\n\u2139 tests 3\n\u2139 pass 1\n\u2139 fail 0\n\u2139 skipped 2\n";
  assert.deepEqual(parseAnyReport(spec), { counts: { tests: 3, pass: 1, fail: 0, skipped: 2, todo: null, cancelled: null }, skipped: [{ test: "python x.test.py", reason: "python3 with jsonschema not found" }, { test: "OutLayer y", reason: "Rust 1.99.0 cargo not found" }] });
  const tap = "ok 1 - a\nok 2 - b # SKIP no rust\nnot ok 3 - c\n# tests 3\n# pass 1\n# fail 1\n# skipped 1\n";
  assert.deepEqual(parseAnyReport(tap).skipped, [{ test: "b", reason: "no rust" }]);
  assert.deepEqual(parseTap(tap).tests.map((t) => [t.ok, t.name, t.directive]), [[true, "a", null], [true, "b", "SKIP"], [false, "c", null]]);
});

test("no loopback: the judge says so up front and on each stage that needs it, and never turns a fail into a pass", () => {
  withCopy((dir) => {
  const r = judge(dir, ["--replay", "--only", "S1,S7"], { TRUENAV_JUDGE_TEST_NO_LOOPBACK: "1" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^WARN local loopback 127\.0\.0\.1 is unavailable.*Stages S5, S6, S7, S8 will fail here\.$/m);
  assert.equal(stage(r, "S1").status, "pass");
  assert.doesNotMatch(stage(r, "S1").evidence, /loopback/, "a stage that does not need loopback is not labeled");
  assert.equal(stage(r, "S7").status, "fail");
  assert.match(stage(r, "S7").evidence, /^local loopback 127\.0\.0\.1 is unavailable.*not a product failure/);
  assert.deepEqual(validate(SCHEMA, r.summary), []);
  const ok = judge(dir, ["--replay", "--only", "S1"]);
  assert.doesNotMatch(ok.stdout, /^WARN/m, "no warning when loopback works");
  });
});
