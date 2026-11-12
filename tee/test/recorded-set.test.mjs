// Which recorded TEE set the verify scripts use, from the contract: the defaults come from tee/status.json with no
// environment variable, the earlier instance stays reachable through flags, and a missing file fails loudly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveSet, flag, EARLIER_VERDICTS, EARLIER_REPORT } from "../recorded-set.mjs";
import { readStatus, checkStatus } from "../status.mjs";

const REPO = new URL("../../", import.meta.url);
const status = readStatus(REPO);
const NO_ENV = {}; // no TRUENAV_* variable at all

test("the committed status is live for the 368aa2 registry and validates against its files", () => {
  assert.equal(status.tee, "live");
  assert.equal(status.registry, "registry.tnlab-368aa2.testnet");
  assert.deepEqual(checkStatus(status, { root: REPO }).problems, []);
});

test("with no flag and no environment the default is the current registry's set from tee/status.json", () => {
  const r = resolveSet({ argv: [], env: NO_ENV, root: REPO });
  assert.equal(r.contract, status.registry);
  assert.equal(r.verdictsPath, status.verdicts_file);
  assert.equal(r.reportPath, status.report_file);
  assert.equal(r.verdictsPath, "tee/fixtures/verdicts-368aa2.json");
  assert.equal(r.reportPath, "tee/fixtures/attestation-report-368aa2.json.b64");
});

test("the earlier instance stays reachable through --contract, and through the old TRUENAV_CONTRACT variable", () => {
  for (const r of [resolveSet({ argv: ["--contract", status.earlier_instance], env: NO_ENV, root: REPO }), resolveSet({ argv: [], env: { TRUENAV_CONTRACT: status.earlier_instance }, root: REPO })]) {
    assert.equal(r.contract, "registry.tnlab-718ca9.testnet");
    assert.equal(r.verdictsPath, EARLIER_VERDICTS);
    assert.equal(r.reportPath, EARLIER_REPORT);
  }
  // the flag wins over the variable
  assert.equal(resolveSet({ argv: ["--contract", status.registry], env: { TRUENAV_CONTRACT: status.earlier_instance }, root: REPO }).contract, status.registry);
});

test("a contract with no recorded set, or a pending status for the current registry, is refused with a clear message", () => {
  assert.throws(() => resolveSet({ argv: ["--contract", "registry.other.testnet"], env: NO_ENV, root: REPO }), /no recorded TEE set for registry\.other\.testnet: it is neither/);
  const pending = { ...status, tee: "pending", verdicts_file: null, report_file: null };
  assert.throws(() => resolveSet({ argv: ["--contract", status.registry], env: NO_ENV, root: REPO, status: pending }), /tee\/status\.json says pending/);
  // a pending status still defaults to the earlier instance
  assert.equal(resolveSet({ argv: [], env: NO_ENV, root: REPO, status: pending }).contract, status.earlier_instance);
  assert.throws(() => flag(["--contract"], "--contract"), /needs a value/);
  assert.throws(() => flag(["--contract", "--report"], "--contract"), /needs a value/);
});

test("a missing file named by the status, by a flag or by the environment fails loudly instead of falling back", () => {
  const dir = mkdtempSync(join(tmpdir(), "recorded-set-"));
  try {
    mkdirSync(join(dir, "tee/fixtures"), { recursive: true });
    const root = pathToFileURL(`${dir}/`);
    assert.throws(() => resolveSet({ argv: [], env: NO_ENV, root, status }), /the verdicts file tee\/fixtures\/verdicts-368aa2\.json does not exist .* Nothing was checked/);
    writeFileSync(join(dir, status.verdicts_file), "{}");
    assert.throws(() => resolveSet({ argv: [], env: NO_ENV, root, status }), /the attestation report tee\/fixtures\/attestation-report-368aa2\.json\.b64 does not exist/);
    assert.throws(() => resolveSet({ argv: ["--verdicts", "tee/fixtures/nope.json", "--report", "tee/fixtures/nope.b64"], env: NO_ENV, root, status }), /nope\.json does not exist/);
    assert.throws(() => resolveSet({ argv: [], env: { TRUENAV_VERDICTS: "x.json", TRUENAV_REPORT: "y.b64" }, root, status }), /x\.json does not exist/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("verify:attestation exits 1 with a FAIL line, before any network access, when the named files are missing", () => {
  const cli = fileURLToPath(new URL("../verify-attestation.mjs", import.meta.url));
  const r = spawnSync(process.execPath, [cli, "--verdicts", "tee/fixtures/does-not-exist.json", "--report", "tee/fixtures/does-not-exist.b64"], { encoding: "utf8", timeout: 20_000, env: { PATH: process.env.PATH } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /FAIL the verdicts file tee\/fixtures\/does-not-exist\.json does not exist/);
  const r2 = spawnSync(process.execPath, [cli, "--contract", "registry.other.testnet"], { encoding: "utf8", timeout: 20_000, env: { PATH: process.env.PATH } });
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /FAIL no recorded TEE set for registry\.other\.testnet/);
});
