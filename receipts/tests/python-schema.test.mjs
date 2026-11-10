// Runs the Python schema and privacy suites from npm test. They need python3 with jsonschema (CI pins 4.23.0).
// Set TRUENAV_PYTHON to pick an interpreter. Skipped, not failed, when no interpreter with jsonschema is found;
// CI also runs each file directly, where a missing jsonschema is a failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const python = process.env.TRUENAV_PYTHON || "python3";
const probe = spawnSync(python, ["-c", "import jsonschema"], { cwd: root, encoding: "utf8" });
const skip = probe.status === 0 ? false : `${python} with jsonschema not found`;

for (const file of ["receipts/tests/receipt-v3.0.1-schema.test.py", "receipts/tests/receipt-v3-schema.test.py", "receipts/tests/receipt-v3-privacy.test.py", "receipts/tests/engine-v3-privacy.test.py"]) {
  test(`python ${file}`, { skip }, () => {
    const run = spawnSync(python, [file], { cwd: root, encoding: "utf8" });
    assert.equal(run.status, 0, `${file}\n${run.stdout}\n${run.stderr}`);
    assert.match(run.stderr, /\nOK/);
  });
}
