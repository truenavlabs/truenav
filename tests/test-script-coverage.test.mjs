// N-08: every *.test.mjs file in the repository must run. A test file that is not listed in the package.json "test"
// script is silently never run by `npm test`, so this test fails for any such file unless it is on the allowlist below
// with the place it does run and the reason it is kept out of `npm test`.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");

/** Test files deliberately not in `npm test`. Each needs a reason and a place where it does run. */
export const ALLOWLIST = {
  "receipts/tests/receipt-v3-interface.test.mjs": {
    reason: "frozen v3 interface vectors; run as its own step next to the Python schema tests so a failure is reported apart from npm test",
    runsIn: ".github/workflows/ci.yml",
  },
};

const testFiles = () =>
  execFileSync("git", ["ls-files", "*.test.mjs"], { cwd: new URL(".", root), encoding: "utf8" }).trim().split("\n").filter(Boolean).sort();

/** The words of the test script before the first "&&": the files node --test runs. */
const scriptFiles = () => {
  const words = JSON.parse(read("package.json")).scripts.test.split(/\s+/);
  const cut = words.indexOf("&&");
  return words.slice(0, cut === -1 ? words.length : cut).filter((w) => w.endsWith(".mjs"));
};

test("every *.test.mjs file is in the npm test script or on the documented allowlist", () => {
  const listed = new Set(scriptFiles());
  const missing = testFiles().filter((f) => !listed.has(f) && !(f in ALLOWLIST));
  assert.deepEqual(missing, [], `not run by npm test (add them before "&& node spec/nav/check.mjs", or allowlist with a reason): ${missing.join(", ")}`);
});

test("no test file is placed after the && in the test script, where node --test would never see it", () => {
  const words = JSON.parse(read("package.json")).scripts.test.split(/\s+/);
  const cut = words.indexOf("&&");
  const after = cut === -1 ? [] : words.slice(cut).filter((w) => w.endsWith(".test.mjs"));
  assert.deepEqual(after, []);
});

test("every file named in the test script exists, and none is listed twice", () => {
  const files = scriptFiles();
  assert.deepEqual(files.filter((f) => !existsSync(new URL(f, root))), []);
  assert.equal(new Set(files).size, files.length);
});

test("every allowlisted file exists, has a reason, and really runs where the allowlist says", () => {
  for (const [file, { reason, runsIn }] of Object.entries(ALLOWLIST)) {
    assert.ok(existsSync(new URL(file, root)), `${file} does not exist: remove it from the allowlist`);
    assert.ok(typeof reason === "string" && reason.length >= 20, `${file} needs a reason`);
    assert.ok(read(runsIn).includes(file), `${file} is allowlisted as running in ${runsIn}, but it is not named there`);
    assert.ok(!scriptFiles().includes(file), `${file} is in npm test: remove it from the allowlist`);
  }
});
