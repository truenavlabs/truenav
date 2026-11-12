import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCounts, checkCounts } from "../ci-test-counts.mjs";

const SUMMARY = (o = {}) => {
  const c = { tests: 425, suites: 0, pass: 425, fail: 0, cancelled: 0, skipped: 0, todo: 0, ...o };
  return Object.entries(c).map(([k, v]) => `# ${k} ${v}`).join("\n") + "\n# duration_ms 1234.5\n";
};

test("parses both the plain and the terminal summary styles", () => {
  assert.deepEqual(parseCounts(SUMMARY()).tests, 425);
  assert.equal(parseCounts("ℹ tests 417\nℹ pass 413\nℹ fail 0\nℹ skipped 4\n").skipped, 4);
});

test("a clean run passes, skipped tests are allowed and no exact pass count is required", () => {
  assert.equal(checkCounts(SUMMARY()).ok, true);
  assert.equal(checkCounts(SUMMARY({ tests: 417, pass: 413, skipped: 4 })).ok, true);
  assert.equal(checkCounts(SUMMARY({ tests: 500, pass: 500 })).ok, true);
});

test("any failure, a cancelled test, an empty run or a missing summary is refused", () => {
  assert.equal(checkCounts(SUMMARY({ pass: 424, fail: 1 })).ok, false);
  assert.equal(checkCounts(SUMMARY({ pass: 424, cancelled: 1 })).ok, false);
  assert.equal(checkCounts(SUMMARY({ tests: 0, pass: 0 })).ok, false);
  assert.equal(checkCounts("All worked example numbers match.\n").ok, false);
  assert.equal(checkCounts("").ok, false);
  assert.match(checkCounts(SUMMARY({ pass: 400 })).problems.join(), /not tests 425/);
});

test("the CLI exits 0 on a clean summary and 1 on a failing one, and prints the counts", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-counts-"));
  try {
    const cli = fileURLToPath(new URL("../ci-test-counts.mjs", import.meta.url));
    const good = join(dir, "good.txt"); writeFileSync(good, SUMMARY());
    const bad = join(dir, "bad.txt"); writeFileSync(bad, SUMMARY({ pass: 424, fail: 1 }));
    const env = { PATH: process.env.PATH };
    const a = spawnSync(process.execPath, [cli, good], { encoding: "utf8", env });
    assert.equal(a.status, 0); assert.match(a.stdout, /npm test counts: tests 425, pass 425, fail 0/);
    const b = spawnSync(process.execPath, [cli, bad], { encoding: "utf8", env });
    assert.equal(b.status, 1); assert.match(b.stderr, /FAIL 1 failing/);
    assert.equal(spawnSync(process.execPath, [cli], { encoding: "utf8", env }).status, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
