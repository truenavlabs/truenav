// The agent's master account comes from --master or TRUENAV_MASTER, with no default (it used to default to tnlab-718ca9.testnet).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseRunArgs, UsageError, USAGE } from "../run-args.mjs";

const cli = fileURLToPath(new URL("../run.mjs", import.meta.url));
const FRESH = "fresh-master-test.testnet";
const run = (argv, env = {}) => spawnSync(process.execPath, [cli, ...argv], { encoding: "utf8", timeout: 20_000, env: { PATH: process.env.PATH, ...env } });

test("master from --master, from TRUENAV_MASTER, or both when they agree", () => {
  assert.equal(parseRunArgs(["DEMO-CREDIT", "--master", FRESH], {}).master, FRESH);
  assert.equal(parseRunArgs(["DEMO-CREDIT"], { TRUENAV_MASTER: FRESH }).master, FRESH);
  assert.equal(parseRunArgs(["--master", FRESH, "DEMO-CREDIT", "--execute", "--api", "http://x"], { TRUENAV_MASTER: FRESH }).master, FRESH);
  const a = parseRunArgs(["--api", "http://127.0.0.1:1", "DEMO-CREDIT", "--execute", "--master", FRESH], {});
  assert.deepEqual(a, { token: "DEMO-CREDIT", execute: true, apiUrl: "http://127.0.0.1:1", master: FRESH });
});

test("no master, a disagreeing master, or a bad master is refused; there is no default", () => {
  assert.throws(() => parseRunArgs(["DEMO-CREDIT"], {}), (e) => e instanceof UsageError && !e.usage && /no master account/.test(e.message) && /no default/.test(e.message));
  assert.throws(() => parseRunArgs(["DEMO-CREDIT", "--master", FRESH], { TRUENAV_MASTER: "other.testnet" }), /disagrees/);
  for (const bad of ["tnlab", "Upper.testnet", "a.b.testnet", "x.near", "-x.testnet", "x_.testnet", `${"a".repeat(41)}.testnet`, "x.testnet "]) {
    assert.throws(() => parseRunArgs(["DEMO-CREDIT", "--master", bad], {}), /not a named \.testnet account/, bad);
  }
});

test("a bad token or flag is a usage error before the master is looked at", () => {
  for (const argv of [[], ["bad_token"], ["-fund"], ["DEMO-CREDIT", "extra"], ["DEMO-CREDIT", "--nope"], ["DEMO-CREDIT", "--master"], ["DEMO-CREDIT", "--api"]]) {
    assert.throws(() => parseRunArgs(argv, {}), (e) => e instanceof UsageError && e.usage, JSON.stringify(argv));
  }
});

test("the CLI exits 2 with a clear message when no master is given, before any network access", () => {
  const r = run(["DEMO-CREDIT"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no master account: pass --master <account\.testnet> or set TRUENAV_MASTER \(there is no default\)/);
  assert.equal(r.stdout, "");
  const r2 = run(["DEMO-CREDIT", "--master", "tnlab-718ca9"]);
  assert.equal(r2.status, 2); assert.match(r2.stderr, /not a named \.testnet account/);
});

test("the CLI keeps printing the usage line on stdout for a bad token, with or without a master", () => {
  for (const env of [{}, { TRUENAV_MASTER: FRESH }]) {
    const r = run(["bad_token"], env);
    assert.equal(r.status, 2);
    assert.equal(r.stdout.trim(), USAGE);
  }
});

test("agent/run.mjs no longer contains the old default master", () => {
  const src = readFileSync(cli, "utf8") + readFileSync(fileURLToPath(new URL("../run-args.mjs", import.meta.url)), "utf8");
  assert.doesNotMatch(src, /tnlab-718ca9/);
  assert.doesNotMatch(src, /TRUENAV_MASTER\s*\|\|\s*["'`]/);
});

test("--execute with a shared account is still refused once a master is given", () => {
  for (const account of [FRESH, `receipts.${FRESH}`, `query.${FRESH}`, `runner.${FRESH}`, `api.${FRESH}`]) {
    const r = run(["DEMO-CREDIT", "--execute", "--master", FRESH], { TRUENAV_AGENT_ACCOUNT: account, TRUENAV_AGENT_KEYFILE: "/nonexistent/agent.json" });
    assert.notEqual(r.status, 0, account);
    assert.match(r.stderr, /is a shared TrueNav account/, account);
  }
});
