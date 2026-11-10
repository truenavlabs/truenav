// RT2-03: a v3 receipt counts as pinned only if its engine is the repo pin (receipts/v3-build.json engine.sha256).
// Before this fix the agent only compared two fields of the same chain row, so a receipt from any engine the
// receipts admin configured got the same decision as one from the pinned build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { decide, verifyRecord, runAgent, newRequestId, PINNED_V3_ENGINES, v3EngineNotPinned } from "../agent.mjs";
import { canonical } from "../../api/receipt.mjs";
import { failedHead } from "./failed-head-fixture.mjs";

const PIN = JSON.parse(readFileSync(new URL("../../receipts/v3-build.json", import.meta.url), "utf8")).engine.sha256;
const raw = JSON.parse(readFileSync(new URL("../../schema/vectors/engine-v3-derived.json", import.meta.url), "utf8")).vectors[0].envelope;
// green, no caps, no holds: the shape that used to reach the engine check last
const green = { ...structuredClone(raw), band: "green", score: 99, caps: [], holds: [] };
const OTHER = "ee".repeat(32);
function record(e) {
  const receipt = canonical(e);
  const d = createHash("sha256").update(receipt).digest("hex");
  return { token_id: e.token_id, seq: Number(e.seq), score: e.score ?? 0, band: e.band, caps: e.caps, holds: e.holds, period: `${e.period_start}/${e.period_end}`, as_of: e.valuation_time, method: e.method_version, version_key: e.engine_version_key, receipt_sha256: d, public_sha256: d, receipt, block_height: 1 };
}
const withEngine = (e, h) => ({ ...structuredClone(e), engine_version_key: h, engine_code_sha256: h });
const nowOf = (e) => Date.parse(e.valuation_time);
function fakeChain(latest) {
  const bought = [];
  return {
    bought,
    async view(_c, method, args) {
      if (method === "get_latest") return latest[args.token_id] ?? null;
      if (method === "get_token") return { token: { token_id: args.token_id }, pending: null, last_failure: null };
      if (method === "get_config") return { fee: (10n ** 22n).toString(), paused: false };
      throw new Error(`unexpected view ${method}`);
    },
    async buyQuery({ requestId, queryHash, kind, deposit }) {
      bought.push(requestId);
      return { request_id: requestId, buyer: "agent.testnet", kind, query_hash: queryHash, paid: deposit.toString(), created_ns: "1", expires_ns: "2", uses_left: 1 };
    },
  };
}

test("RT2-03 the allowlist is exactly the v3-build.json engine pin, and the test vector carries it", () => {
  assert.match(PIN, /^[0-9a-f]{64}$/);
  assert.deepEqual([...PINNED_V3_ENGINES], [PIN]);
  assert.equal(raw.engine_version_key, PIN);
  assert.equal(raw.engine_code_sha256, PIN);
});

test("RT2-03 a pinned v3 receipt is still review unattested", () => {
  const r = record(green);
  assert.deepEqual(decide(r.token_id, r, { nowMs: nowOf(green) }).reason, "unattested");
});

test("RT2-03 a v3 receipt from a non-pinned engine is declined engine_hash, not treated like the pinned one", () => {
  const r = record(withEngine(green, OTHER));
  assert.equal(verifyRecord(r.token_id, r), null, "the receipt itself is consistent; only the engine is wrong");
  const out = decide(r.token_id, r, { nowMs: nowOf(green) });
  assert.equal(out.action, "decline");
  assert.equal(out.reason, "engine_hash");
});

test("RT2-03 the engine check runs before the score rules (red, hold, yellow, capped, stale)", () => {
  const shapes = [
    { band: "red", score: 40 },
    { holds: ["concentration_top_five"] },
    { band: "yellow", score: 70 },
    { caps: ["yield_gap"] },
  ];
  for (const edit of shapes) {
    const r = record(withEngine({ ...green, ...edit }, OTHER));
    assert.equal(decide(r.token_id, r, { nowMs: nowOf(green) }).reason, "engine_hash", JSON.stringify(edit));
  }
  const stale = record(withEngine(green, OTHER));
  assert.equal(decide(stale.token_id, stale, { nowMs: nowOf(green) + 400 * 86_400_000 }).reason, "engine_hash");
});

test("RT2-03 engine_code_sha256 that differs from a pinned version_key is declined", () => {
  const r = record({ ...structuredClone(green), engine_code_sha256: OTHER });
  assert.equal(decide(r.token_id, r, { nowMs: nowOf(green) }).reason, "engine_hash");
  assert.match(v3EngineNotPinned({ engine_version_key: PIN, engine_code_sha256: OTHER }, PIN), /engine_code_sha256/);
  assert.match(v3EngineNotPinned({ engine_version_key: OTHER }, PIN), /engine_version_key/);
  assert.equal(v3EngineNotPinned({ engine_version_key: PIN, engine_code_sha256: PIN }, PIN), null);
});

test("RT2-03 fail closed: an empty allowlist pins nothing", () => {
  assert.match(v3EngineNotPinned({ engine_version_key: PIN, engine_code_sha256: PIN }, PIN, new Set()), /not a pinned build/);
});

test("RT2-03 the agent buys nothing for a non-pinned engine, and still buys for the pinned one", async () => {
  const bad = record(withEngine(green, OTHER));
  const chain = fakeChain({ [bad.token_id]: bad });
  const out = await runAgent({ chain, token: bad.token_id, receipts: "r.testnet", query: "q.testnet", requestId: newRequestId(bad.token_id, "1".repeat(12)), nowMs: nowOf(green), execute: true });
  assert.equal(out.decision.reason, "engine_hash");
  assert.deepEqual(out.entitlement, { bought: false, why: "engine_hash" });
  assert.equal(chain.bought.length, 0);
  const good = record(green);
  const chain2 = fakeChain({ [good.token_id]: good });
  const out2 = await runAgent({ chain: chain2, token: good.token_id, receipts: "r.testnet", query: "q.testnet", requestId: newRequestId(good.token_id, "2".repeat(12)), nowMs: nowOf(green), execute: true });
  assert.equal(out2.decision.reason, "unattested");
  assert.equal(chain2.bought.length, 1);
});

test("RT2-03 a failed head is still run_failed whatever its engine key", () => {
  const h = failedHead("DEMO-CREDIT", { v3: true });
  assert.equal(decide("DEMO-CREDIT", h).reason, "run_failed");
});
