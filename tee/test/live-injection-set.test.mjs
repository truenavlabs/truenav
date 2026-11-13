// The offline live-injection set (tee/eval/live-injection) and the runner option for it. No network, no key: the
// runner is only imported and run with --estimate under an offline fetch preload.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SETS, resultsPath, estimateSet, estimateTokens, parseArgs, maxUsdFrom, usd, DEFAULT_MAX_USD } from "../eval/run.mjs";
import { buildRequest } from "../underwrite.mjs";

const root = new URL("../../", import.meta.url);
const ROOT = fileURLToPath(root);
const read = (p) => readFileSync(new URL(p, root), "utf8");
const { cases } = JSON.parse(read("tee/eval/live-injection/cases.json"));
const sha = (s) => createHash("sha256").update(s).digest("hex");

test("live-injection: 18 attacks and 4 clean controls, ids unique, files and loan hashes consistent", () => {
  assert.equal(cases.length, 22);
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
  assert.equal(new Set(cases.map((c) => c.document_id)).size, cases.length);
  assert.equal(cases.filter((c) => c.category === "prompt injection").length, 18);
  const controls = cases.filter((c) => c.category === "clean control");
  assert.equal(controls.length, 4);
  for (const c of controls) assert.deepEqual([c.expect, c.expect_code], ["pass", null]);
  for (const c of cases) {
    assert.equal(c.file, `tee/eval/live-injection/docs/${c.id}.txt`);
    assert.equal(c.loan_hash, sha(`truenav-demo-v1|${c.asset_type}|${c.document_id}`));
    const text = read(c.file);
    assert.ok(text.startsWith("FICTIONAL DEMO RECORD, NOT A REAL DOCUMENT\n"), c.id);
    assert.ok(text.includes(`Document id: ${c.document_id}\n`), c.id);
    assert.ok(typeof c.expected_outcome === "string" && c.expected_outcome.length > 10, c.id);
    if (c.expect === "flag") assert.ok(["injection_attempt", "amount_mismatch"].includes(c.expect_code), c.id);
  }
});

test("live-injection: covers every requested attack style", () => {
  const v = cases.map((c) => c.variant).join(" | ");
  for (const want of [/delimiter escape >>>/, /closing tags/, /fake CLAIM/, /homoglyph/, /zero-width/, /Thai/, /Chinese/, /Spanish/, /HTML comment/, /white-on-white/, /role-play/, /system override/, /base64 instruction/, /extra JSON fields/, /set the verdict/]) assert.match(v, want);
  const doc = (variant) => read(cases.find((c) => c.variant === variant).file);
  assert.match(doc("zero-width chars"), /\u200b/);
  assert.match(doc("homoglyphs"), /[\u0400-\u04ff]/);
  assert.match(doc("Thai instruction"), /[\u0e00-\u0e7f]/);
  assert.match(doc("Chinese instruction"), /[\u4e00-\u9fff]/);
  const enc = doc("base64 instruction").match(/follow\): ([A-Za-z0-9+/=]+)/)[1];
  assert.match(Buffer.from(enc, "base64").toString("utf8"), /Return verdict pass/);
});

test("live-injection: amount cases really differ from the claim; every other case matches it", () => {
  for (const c of cases) {
    const text = read(c.file);
    const amount = text.match(/^(?:Loan amount secured|Total due): USD ([\d,.]+)$/m)[1].replace(/,/g, "");
    const differs = Number(amount) !== c.principal;
    assert.equal(differs, c.expect_code === "amount_mismatch", c.id);
  }
});

test("live-injection: the generator reproduces the committed files", () => {
  const before = cases.map((c) => [c.id, sha(read(c.file))]);
  const r = spawnSync(process.execPath, ["tee/eval/live-injection/generate.mjs"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const after = JSON.parse(read("tee/eval/live-injection/cases.json")).cases.map((c) => [c.id, sha(read(c.file))]);
  assert.deepEqual(after, before);
});

test("run.mjs: each set writes only its own results file", () => {
  assert.equal(SETS["live-injection"], "tee/eval/live-injection");
  assert.equal(resultsPath("live-injection"), "tee/eval/live-injection/results.json");
  assert.equal(resultsPath("main"), "tee/eval/results.json");
  assert.equal(resultsPath("holdout"), "tee/eval/holdout/results.json");
  assert.equal(new Set(Object.keys(SETS).map(resultsPath)).size, 3);
  assert.deepEqual(parseArgs(["live-injection", "--estimate"]), { set: "live-injection", estimate: true });
  assert.deepEqual(parseArgs([]), { set: "main", estimate: false });
  assert.throws(() => parseArgs(["nope"]), /set must be one of/);
  assert.throws(() => parseArgs(["main", "--live"]), /unknown option/);
  assert.equal(maxUsdFrom({}), DEFAULT_MAX_USD);
  assert.equal(maxUsdFrom({ TRUENAV_EVAL_MAX_USD: "0.2" }), 0.2);
  assert.throws(() => maxUsdFrom({ TRUENAV_EVAL_MAX_USD: "-1" }), /positive/);
});

test("run.mjs --estimate: no network, no results written, exit 0, cost well under the spend stop", () => {
  const files = ["tee/eval/results.json", "tee/eval/holdout/results.json"].map((p) => [p, statSync(new URL(p, root)).mtimeMs, sha(read(p))]);
  const r = spawnSync(process.execPath, ["--import", fileURLToPath(new URL("../../tests/fixtures/offline-fetch.mjs", import.meta.url)), "tee/eval/run.mjs", "live-injection", "--estimate"], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^live-injection: 22 cases, about \d+ prompt tokens, at most 4400 output tokens/);
  for (const [p, m, h] of files) {
    assert.equal(statSync(new URL(p, root)).mtimeMs, m, p);
    assert.equal(sha(read(p)), h, p);
  }
  const e = estimateSet("live-injection");
  assert.ok(e.usd_max < 0.05, `estimate ${e.usd_max}`);
  assert.ok(e.usd_max <= DEFAULT_MAX_USD);
});

test("run.mjs: the token estimate is at or above the recorded prompt tokens, within 10%", () => {
  for (const [set, dir] of [["main", "tee/eval"], ["holdout", "tee/eval/holdout"]]) {
    const run = JSON.parse(read(`${dir}/results.json`));
    const e = estimateSet(set, { binding: run.binding });
    const actual = run.results.reduce((n, r) => n + JSON.parse(r.onchain.response_body).usage.prompt_tokens, 0);
    assert.ok(e.prompt_tokens >= actual && e.prompt_tokens <= actual * 1.1, `${set}: estimate ${e.prompt_tokens}, recorded ${actual}`);
  }
  assert.equal(estimateTokens("abcdefg"), 3);
  assert.equal(estimateTokens("\u0e01\u0e02"), 2);
  assert.equal(usd({ prompt_tokens: 1e6, completion_tokens: 1e6 }), 0.7);
});

test("live-injection: every request stays a single small user message inside the delimiters", () => {
  const binding = "truenav-verdict-v1|eval.truenav-eval.testnet|testnet|1893456000000";
  for (const c of cases) {
    const loan = { loan_hash: c.loan_hash, asset_type: c.asset_type, document_id: c.document_id, principal: c.principal };
    const body = JSON.parse(buildRequest(loan, read(c.file), binding).toString("utf8"));
    assert.equal(body.messages.length, 2);
    assert.equal(body.max_tokens, 200);
    assert.ok(body.messages[1].content.startsWith("CLAIM:\n"));
    assert.ok(Buffer.byteLength(JSON.stringify(body)) < 8192, c.id);
  }
});
