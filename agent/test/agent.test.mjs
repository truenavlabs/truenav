// Demo agent: the decision rule and the read / buy / act flow against a fake chain, on the real engine receipts
// (receipts/tests/fixtures/engine-receipts.json). No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { decide, verifyRecord, runAgent, summary, queryHash, newRequestId } from "../agent.mjs";

const fx = JSON.parse(readFileSync(new URL("../../receipts/tests/fixtures/engine-receipts.json", import.meta.url), "utf8")).receipts;
const NOW = Date.parse("2026-11-08T12:00:00Z");
const FEE = 10n ** 22n;
// a stored record as the receipt contract's get_latest returns it
function stored(key, edit = (r) => r) {
  const receipt = fx[key].output;
  const r = JSON.parse(receipt);
  return edit({ token_id: r.token_id, seq: 1, request_id: 1, method: r.method, version_key: "ab".repeat(32), score: r.score, band: r.band, period: r.period, as_of: r.as_of, caps: r.caps.map((c) => c.code), holds: r.holds.map((h) => h.code), receipt_sha256: createHash("sha256").update(receipt).digest("hex"), receipt, requested_ns: 1, stored_ns: 2, block_height: 100 });
}
function fakeChain({ latest = {}, fee = FEE, paused = false } = {}) {
  const bought = [];
  return {
    bought,
    async view(contract, method, args) {
      if (method === "get_latest") return latest[args.token_id] ?? null;
      if (method === "get_token") return { token: { token_id: args.token_id }, pending: null, last_failure: null };
      if (method === "get_config") return { fee: fee.toString(), paused };
      throw new Error(`unexpected view ${method}`);
    },
    async buyQuery({ requestId, queryHash, kind, deposit }) {
      bought.push({ requestId, queryHash, kind, deposit });
      return { request_id: requestId, buyer: "agent.testnet", kind, query_hash: queryHash, paid: deposit.toString(), created_ns: "1", expires_ns: "2", uses_left: 1, tx_hash: "TX" };
    },
  };
}
const run = (chain, token, o = {}) => runAgent({ chain, token, receipts: "receipts.testnet", query: "query.testnet", requestId: newRequestId(token, "0".repeat(12)), nowMs: NOW, execute: true, ...o });
// index fields and receipt bytes edited together, so the record still verifies
const withReceipt = (key, f) => stored(key, (r) => {
  const rec = JSON.parse(r.receipt);
  f(rec, r);
  r.receipt = JSON.stringify(rec);
  r.receipt_sha256 = createHash("sha256").update(r.receipt).digest("hex");
  return r;
});

test("the rule on the real receipts: demo funds declined (red, with their caps), honest funds approved", () => {
  const dc = decide("DEMO-CREDIT", stored("DEMO-CREDIT"), { nowMs: NOW });
  assert.deepEqual([dc.action, dc.reason], ["decline", "red"]);
  assert.match(dc.detail, /score 58 red: yield_gap, claimed_not_settled, collection_shortfall/);
  assert.equal(decide("DEMO-RENTAL", stored("DEMO-RENTAL"), { nowMs: NOW }).action, "decline");
  assert.deepEqual(Object.values(decide("HONEST-CREDIT", stored("HONEST-CREDIT"), { nowMs: NOW })).slice(0, 2), ["approve", "green"]);
  assert.equal(decide("HONEST-RENTAL", stored("HONEST-RENTAL"), { nowMs: NOW }).action, "approve");
  // severe arrears: 59 red
  const ar = decide("HONEST-RENTAL", stored("HONEST-RENTAL-ARREARS"), { nowMs: NOW });
  assert.deepEqual([ar.action, ar.reason], ["decline", "red"]);
  assert.match(ar.detail, /score 59 red: payout_exceeds_net_cash, collection_shortfall/);
});

test("the rule's other branches: no receipt, yellow, hold, stale, and a record that does not match its bytes", () => {
  assert.deepEqual(Object.values(decide("X", null)).slice(0, 2), ["decline", "no_receipt"]);
  const yellow = withReceipt("HONEST-CREDIT", (rec, r) => { rec.score = r.score = 72; rec.band = r.band = "yellow"; });
  assert.deepEqual(Object.values(decide("HONEST-CREDIT", yellow, { nowMs: NOW })).slice(0, 2), ["review", "yellow"]);
  const held = withReceipt("HONEST-CREDIT", (rec, r) => { rec.score = r.score = 84; rec.band = r.band = "yellow"; rec.holds = [{ code: "collection_pending", reason: "x" }]; r.holds = ["collection_pending"]; });
  assert.deepEqual(Object.values(decide("HONEST-CREDIT", held, { nowMs: NOW })).slice(0, 2), ["review", "hold"]);
  const later = NOW + 46 * 86_400_000;
  assert.deepEqual(Object.values(decide("HONEST-CREDIT", stored("HONEST-CREDIT"), { nowMs: later })).slice(0, 2), ["review", "stale"]);
  // index says green, bytes say red: declined, never approved
  const forged = stored("DEMO-CREDIT", (r) => ({ ...r, score: 95, band: "green", caps: [] }));
  assert.equal(verifyRecord("DEMO-CREDIT", forged), "receipt_index_mismatch");
  assert.deepEqual(Object.values(decide("DEMO-CREDIT", forged, { nowMs: NOW })).slice(0, 2), ["decline", "receipt_mismatch"]);
  assert.equal(verifyRecord("DEMO-CREDIT", { ...stored("DEMO-CREDIT"), receipt_sha256: "00".repeat(32) }), "receipt_sha256_mismatch");
  assert.equal(verifyRecord("HONEST-CREDIT", stored("DEMO-CREDIT")), "receipt_token_mismatch");
});

test("the flow: free score read, exactly one report entitlement bought for the fee, decision with the receipt reference", async () => {
  const chain = fakeChain({ latest: { "HONEST-CREDIT": stored("HONEST-CREDIT") } });
  const out = await run(chain, "HONEST-CREDIT");
  assert.equal(out.decision.action, "approve");
  assert.equal(chain.bought.length, 1);
  assert.deepEqual(chain.bought[0], { requestId: "agent-HONEST-CREDIT-000000000000", queryHash: queryHash("report", "HONEST-CREDIT"), kind: "report", deposit: FEE });
  assert.equal(out.entitlement.bought, true);
  assert.equal(out.entitlement.paid, FEE.toString());
  assert.equal(out.receipt.receipt_sha256, stored("HONEST-CREDIT").receipt_sha256);
  assert.match(summary(out), /^APPROVE HONEST-CREDIT: score 100 green, no caps, no holds\. Receipt receipts\.testnet HONEST-CREDIT seq 1 receipt_sha256 [0-9a-f]{16}\.\.\. \(cashflow-v2\.1\.0, build abababababab\.\.\.\); entitlement agent-HONEST-CREDIT-000000000000 on query\.testnet, paid 10000000000000000000000 yoctoNEAR$/);
});

test("nothing is bought without a receipt, for a mismatched record, above the max fee, while paused, or in print-only mode", async () => {
  let chain = fakeChain();
  let out = await run(chain, "DEMO-CREDIT");
  assert.deepEqual([out.decision.reason, out.entitlement.bought, chain.bought.length], ["no_receipt", false, 0]);
  chain = fakeChain({ latest: { "DEMO-CREDIT": stored("DEMO-CREDIT", (r) => ({ ...r, receipt_sha256: "00".repeat(32) })) } });
  out = await run(chain, "DEMO-CREDIT");
  assert.deepEqual([out.decision.reason, chain.bought.length], ["receipt_mismatch", 0]);
  chain = fakeChain({ latest: { "DEMO-CREDIT": stored("DEMO-CREDIT") }, fee: FEE * 2n });
  await assert.rejects(run(chain, "DEMO-CREDIT"), /above the agent's maximum/);
  assert.equal(chain.bought.length, 0);
  chain = fakeChain({ latest: { "DEMO-CREDIT": stored("DEMO-CREDIT") }, paused: true });
  await assert.rejects(run(chain, "DEMO-CREDIT"), /paused/);
  chain = fakeChain({ latest: { "DEMO-CREDIT": stored("DEMO-CREDIT") } });
  out = await run(chain, "DEMO-CREDIT", { execute: false });
  assert.equal(chain.bought.length, 0);
  assert.deepEqual(out.entitlement.would_buy, { contract: "query.testnet", method: "buy_query", args: { request_id: "agent-DEMO-CREDIT-000000000000", query_hash: queryHash("report", "DEMO-CREDIT"), kind: "report" }, deposit: FEE.toString() });
  assert.equal(out.decision.action, "decline", "the decision does not depend on paying");
});

test("an entitlement that does not match the purchase is refused", async () => {
  const chain = fakeChain({ latest: { "HONEST-RENTAL": stored("HONEST-RENTAL") } });
  chain.buyQuery = async ({ requestId, kind, deposit }) => ({ request_id: requestId, kind, query_hash: queryHash("report", "DEMO-CREDIT"), paid: deposit.toString(), uses_left: 1 });
  await assert.rejects(run(chain, "HONEST-RENTAL"), /does not match the purchase/);
  assert.equal(newRequestId("HONEST-RENTAL", "x".repeat(80)).length, 64);
});

test("a green score with any cap is reviewed with the caps as reasons, never approved and never called uncapped", () => {
  const capped = withReceipt("HONEST-CREDIT", (rec, r) => {
    rec.caps = [{ code: "claimed_not_settled", reason: "x" }];
    r.caps = ["claimed_not_settled"];
  });
  const d = decide("HONEST-CREDIT", capped, { nowMs: NOW });
  assert.deepEqual([d.action, d.reason], ["review", "capped"]);
  assert.equal(d.detail, "score 100 green but capped: claimed_not_settled");
  assert.doesNotMatch(d.detail, /no caps/);
  // the approve line only ever appears with no caps and no holds
  const ok = decide("HONEST-CREDIT", stored("HONEST-CREDIT"), { nowMs: NOW });
  assert.equal(ok.action, "approve");
  assert.deepEqual(stored("HONEST-CREDIT").caps, []);
});

test("caps, holds or as_of that differ from the stored receipt: declined, nothing bought", async () => {
  const cases = [
    ["receipt_caps_mismatch", (r) => ({ ...r, caps: [] })], // index hides DEMO-CREDIT's caps
    ["receipt_caps_mismatch", (r) => ({ ...r, caps: [...r.caps].reverse() })],
    ["receipt_holds_mismatch", (r) => ({ ...r, holds: ["collection_pending"] })],
    ["receipt_holds_mismatch", (r) => ({ ...r, holds: undefined })],
    ["receipt_as_of_mismatch", (r) => ({ ...r, as_of: "2026-11-08T10:00:00Z" })],
  ];
  for (const [code, edit] of cases) {
    const rec = stored("DEMO-CREDIT", edit);
    assert.equal(verifyRecord("DEMO-CREDIT", rec), code);
    const chain = fakeChain({ latest: { "DEMO-CREDIT": rec } });
    const out = await run(chain, "DEMO-CREDIT");
    assert.deepEqual([out.decision.action, out.decision.reason, out.decision.detail, out.entitlement.bought, chain.bought.length], ["decline", "receipt_mismatch", code, false, 0]);
  }
  // a green index over a stale receipt cannot dodge the 45-day check by editing as_of
  const fresh = stored("HONEST-CREDIT", (r) => ({ ...r, as_of: "2026-12-30T00:00:00Z" }));
  assert.equal(decide("HONEST-CREDIT", fresh, { nowMs: NOW }).reason, "receipt_mismatch");
});

test("runAgent buys nothing unless execute: true is passed", async () => {
  const chain = fakeChain({ latest: { "HONEST-CREDIT": stored("HONEST-CREDIT") } });
  const out = await runAgent({ chain, token: "HONEST-CREDIT", receipts: "receipts.testnet", query: "query.testnet", requestId: newRequestId("HONEST-CREDIT", "0".repeat(12)), nowMs: NOW });
  assert.equal(chain.bought.length, 0);
  assert.deepEqual([out.entitlement.bought, out.entitlement.why], [false, "print_only"]);
  assert.equal(out.entitlement.would_buy.deposit, FEE.toString());
  assert.equal(out.decision.action, "approve");
});
