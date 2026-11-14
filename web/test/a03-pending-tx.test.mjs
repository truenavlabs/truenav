// A03: a transaction that is pending, unknown or failed must never be shown as "succeeded" or counted as a pass.
// Offline: the receipts view and the RPC are mocks. No live RPC, no keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RECEIPTS_CONTRACT } from "../src/lib/near.mjs";
import { extractTx, verifyReceipt } from "../src/lib/receipt-verify.mjs";

const HASH = "6zgh2u9DqHHiXzdy9ouTP7oGky2T4nugqzqt9wJZwNFm";
const VERSION = "ab".repeat(32);
const EMPTY_CONFIG = { admin: "tnlab-718ca9.testnet", pauser: "tnlab-718ca9.testnet", paused: false, config: { method: "truenav-v3.0.1", version_key: VERSION }, next_request: 1 };

const viewReceipts = async (method) => {
  if (method !== "get_config") throw new Error(`unexpected view ${method}`);
  return EMPTY_CONFIG;
};

/** A tx RPC result with a chosen status (undefined leaves the status out). */
const txWith = (status, { receiverId = RECEIPTS_CONTRACT, hash = HASH } = {}) => {
  const r = {
    transaction: { hash, signer_id: "runner.tnlab-718ca9.testnet", receiver_id: receiverId },
    transaction_outcome: { id: hash, outcome: { logs: [], receipt_ids: [] } },
    receipts_outcome: [],
  };
  if (status !== undefined) r.status = status;
  return r;
};

const run = (status) => verifyReceipt({ query: HASH, viewReceipts, rpc: async () => txWith(status) });
const txCheck = (r) => r.checks.find((c) => c.id === "tx-status");

const NOT_SUCCESS = [
  ["status Unknown", "Unknown"],
  ["status Started", "Started"],
  ["status NotStarted", "NotStarted"],
  ["status SuccessReceiptId (receipt still pending)", { SuccessReceiptId: "9ZkqJ2dC6hTq7kqQz1Zk1111111111111111111111" }],
  ["status missing, only a hash", undefined],
  ["status is an empty object", {}],
];

for (const [name, status] of NOT_SUCCESS) {
  test(`A03: ${name} is not shown as succeeded and is not counted as a pass`, async () => {
    assert.equal(extractTx(txWith(status)).success, false);
    const r = await run(status);
    const c = txCheck(r);
    assert.ok(c, "a tx-status row is shown");
    assert.notEqual(c.state, "live", c.detail);
    assert.doesNotMatch(c.detail, /succeeded/i);
    assert.match(c.detail, /pending|unknown/i);
    assert.equal(r.summary.counts.live, 0, JSON.stringify(r.checks.filter((x) => x.state === "live")));
    assert.equal(r.summary.ok, false);
  });
}

test("A03: a failed transaction fails and is not shown as succeeded", async () => {
  const r = await run({ Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: paused" } } } } });
  const c = txCheck(r);
  assert.equal(c.state, "fail");
  assert.match(c.detail, /failed/i);
  assert.doesNotMatch(c.detail, /succeeded/i);
  assert.equal(r.summary.ok, false);
});

test("A03 guard: a successful transaction still passes and says succeeded", async () => {
  const r = await run({ SuccessValue: "" });
  const c = txCheck(r);
  assert.equal(c.state, "live");
  assert.match(c.detail, new RegExp(`Transaction ${HASH} succeeded on ${RECEIPTS_CONTRACT.replace(/\./g, "\\.")}`));
  assert.equal(extractTx(txWith({ SuccessValue: "" })).success, true);
  assert.equal(r.checks.find((x) => x.id === "tx-receiver").state, "live");
  assert.equal(r.summary.ok, true);
});
