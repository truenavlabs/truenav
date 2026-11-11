// Failed head (N3, N4, N6): a failed head is declined as run_failed and nothing is bought, a failed head for another
// token is a receipt_token_mismatch, and red or yellow receipts still buy a report. Fake chain, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decide, verifyRecord, runAgent, newRequestId } from "../agent.mjs";
import { canonical } from "../../api/receipt.mjs";
import { failedHead } from "./failed-head-fixture.mjs";

const NOW = Date.parse("2026-11-08T12:00:00Z");
const FEE = 10n ** 22n;
const sha = (s) => createHash("sha256").update(s).digest("hex");
const fx = JSON.parse(readFileSync(new URL("../../receipts/tests/fixtures/engine-receipts.json", import.meta.url), "utf8")).receipts;

function v2Stored(key) {
  const receipt = fx[key].output;
  const r = JSON.parse(receipt);
  return { token_id: r.token_id, seq: 1, request_id: 1, method: r.method, version_key: "ab".repeat(32), score: r.score, band: r.band, period: r.period, as_of: r.as_of, caps: r.caps.map((c) => c.code), holds: r.holds.map((h) => h.code), receipt_sha256: sha(receipt), receipt, requested_ns: 1, stored_ns: 2, block_height: 100 };
}
function fakeChain(latest) {
  const bought = [];
  return {
    bought,
    async view(_contract, method, args) {
      if (method === "get_latest") return latest[args.token_id] ?? null;
      if (method === "get_token") return { token: { token_id: args.token_id }, pending: null, last_failure: null };
      if (method === "get_config") return { fee: FEE.toString(), paused: false };
      throw new Error(`unexpected view ${method}`);
    },
    async buyQuery({ requestId, queryHash, kind, deposit }) {
      bought.push({ requestId, queryHash, kind, deposit });
      return { request_id: requestId, buyer: "agent.testnet", kind, query_hash: queryHash, paid: deposit.toString(), created_ns: "1", expires_ns: "2", uses_left: 1, tx_hash: "TX" };
    },
  };
}
const run = (chain, token, o = {}) => runAgent({ chain, token, receipts: "receipts.testnet", query: "query.testnet", requestId: newRequestId(token, "0".repeat(12)), nowMs: NOW, execute: true, ...o });

test("fix13 a valid failed head is declined as run_failed and runAgent(execute) buys nothing", async () => {
  for (const v3 of [true, false]) {
    const token = "DEMO-CREDIT";
    const head = failedHead(token, { v3 });
    assert.equal(verifyRecord(token, head), null, `v3=${v3}`);
    assert.deepEqual(Object.values(decide(token, head, { nowMs: NOW })).slice(0, 2), ["decline", "run_failed"]);
    const chain = fakeChain({ [token]: head });
    // apiUrl points nowhere: if the agent tried to spend an entitlement, fetch would throw
    const out = await run(chain, token, { apiUrl: "http://127.0.0.1:9" });
    assert.equal(out.decision.reason, "run_failed");
    assert.equal(chain.bought.length, 0, `v3=${v3}: no entitlement on a failed head`);
    assert.deepEqual(out.entitlement, { bought: false, why: "run_failed" });
  }
});

test("fix13 a failed head for another token is receipt_token_mismatch and nothing is bought", async () => {
  for (const v3 of [true, false]) {
    for (const edit of [{ bodyToken: "OTHER-FUND" }, { recordToken: "OTHER-FUND" }, { bodyToken: "OTHER-FUND", recordToken: "OTHER-FUND" }]) {
      const head = failedHead("DEMO-CREDIT", { v3, ...edit });
      assert.equal(verifyRecord("DEMO-CREDIT", head), "receipt_token_mismatch", `v3=${v3} ${JSON.stringify(edit)}`);
      assert.deepEqual(Object.values(decide("DEMO-CREDIT", head, { nowMs: NOW })).slice(0, 2), ["decline", "receipt_mismatch"]);
      const chain = fakeChain({ "DEMO-CREDIT": head });
      const out = await run(chain, "DEMO-CREDIT");
      assert.equal(chain.bought.length, 0);
      assert.equal(out.entitlement.bought, false);
    }
  }
  // the failed head still has its private-field checks
  const salted = failedHead("DEMO-CREDIT");
  const body = { ...JSON.parse(salted.receipt), private_salt: "ab".repeat(32) };
  salted.receipt = canonical(body);
  salted.receipt_sha256 = sha(salted.receipt);
  assert.equal(verifyRecord("DEMO-CREDIT", salted), "private_salt_published");
});

test("fix13 a red receipt is still declined but still buys one report entitlement", async () => {
  const chain = fakeChain({ "DEMO-CREDIT": v2Stored("DEMO-CREDIT") });
  const out = await run(chain, "DEMO-CREDIT");
  assert.deepEqual([out.decision.action, out.decision.reason], ["decline", "red"]);
  assert.equal(chain.bought.length, 1);
  assert.equal(out.entitlement.bought, true);
});

test("fix13 agent/run.mjs refuses a bad token before it builds a chain client", () => {
  const cli = fileURLToPath(new URL("../run.mjs", import.meta.url));
  for (const argv of [[], ["bad_token"], ["-fund"], ["fund--id"], ["a".repeat(65)], ["fúnd"], ["fund\n"]]) {
    const r = spawnSync(process.execPath, [cli, ...argv], { encoding: "utf8", env: { PATH: process.env.PATH }, timeout: 20_000 });
    assert.equal(r.status, 2, `${JSON.stringify(argv)}: ${r.stderr}`);
    assert.match(r.stdout, /^usage: node agent\/run\.mjs <TOKEN>/);
  }
});
