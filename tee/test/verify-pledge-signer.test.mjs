// RT3-06: verify:pledge-signer reads local files only. Its output must say so and must not state chain facts it never read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (p) => readFileSync(`${root}${p}`, "utf8");
const run = (args = []) => spawnSync(process.execPath, ["tee/verify-pledge-signer.mjs", ...args], { cwd: root, encoding: "utf8" });

test("RT3-06 guard: the committed pledge signer evidence still passes with exit 0", () => {
  const r = run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /verify:pledge-signer PASS/);
  assert.match(r.stdout, /evidence sha256 [0-9a-f]{64}/);
});

test("RT3-06: the output says the chain was not read and does not claim a hash is stored on chain", () => {
  const out = run().stdout;
  assert.match(out, /chain: not read/i);
  assert.doesNotMatch(out, /this hash is stored/i);
  assert.doesNotMatch(out, /ticket signature is checked/i);
  assert.match(out, /not checked:.*(chain|registry)/i);
});

test("RT3-06: the script makes no network or chain call, so the wording is true", () => {
  const src = read("tee/verify-pledge-signer.mjs");
  assert.doesNotMatch(src, /fetch\(|node:https?|web\/chain|near-api|XMLHttpRequest/);
});

test("RT3-06: TRUST_MODEL.md says the script does not read the chain", () => {
  const line = read("TRUST_MODEL.md").split("\n").find((l) => l.includes("npm run verify:pledge-signer"));
  assert.ok(line, "the paragraph naming the script exists");
  assert.match(line, /does not read the chain/i);
});

test("RT3-06: a failing check still exits 1 and prints FAIL", () => {
  const e = "tee/fixtures/pledge-signer/evidence.json";
  const r = run([e, e]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /verify:pledge-signer FAIL/);
});
