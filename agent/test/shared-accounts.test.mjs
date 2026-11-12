// README claim (Roles and keys): the demo agent, when used on testnet, signs with its own account and refuses the
// master, receipts., query., runner. and api. accounts. The check in agent/run.mjs runs before any key file or
// network access, so this test needs neither.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../run.mjs", import.meta.url));
const MASTER = "claim-check-master.testnet";
const run = (account, extra = {}) =>
  spawnSync(process.execPath, [cli, "DEMO-CREDIT", "--execute"], {
    encoding: "utf8",
    timeout: 20_000,
    env: { PATH: process.env.PATH, TRUENAV_MASTER: MASTER, TRUENAV_AGENT_ACCOUNT: account, TRUENAV_AGENT_KEYFILE: "/nonexistent/agent.json", ...extra },
  });

test("agent/run.mjs --execute refuses the master and its receipts, query, runner and api accounts", () => {
  for (const account of [MASTER, `receipts.${MASTER}`, `query.${MASTER}`, `runner.${MASTER}`, `api.${MASTER}`]) {
    const r = run(account);
    assert.notEqual(r.status, 0, account);
    assert.match(r.stderr, new RegExp(`${account.replace(/\./g, "\\.")} is a shared TrueNav account; the agent signs with its own account only`), account);
  }
});

test("agent/run.mjs --execute does not call another account shared", () => {
  const r = run("some-agent.testnet");
  assert.doesNotMatch(r.stderr, /is a shared TrueNav account/);
});

test("agent/run.mjs --execute needs an account and a key file, and the master env var is honoured", () => {
  const r = spawnSync(process.execPath, [cli, "DEMO-CREDIT", "--execute"], { encoding: "utf8", timeout: 20_000, env: { PATH: process.env.PATH, TRUENAV_MASTER: MASTER } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--execute needs TRUENAV_AGENT_ACCOUNT and TRUENAV_AGENT_KEYFILE/);
});
