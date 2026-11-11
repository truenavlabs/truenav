// S4 adapter: reads the agent's v3 engine allowlist and runs the agent on a fake chain (no network, no key) with the
// committed v3 vector and with the same receipt from another engine. Prints one JSON line. A missing or empty
// receipts/v3-build.json throws, which fails S4.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const root = new URL("../../", import.meta.url);
const build = JSON.parse(readFileSync(new URL("receipts/v3-build.json", root), "utf8"));
const buildPin = build?.engine?.sha256 ?? null;
const { PINNED_V3_ENGINES, runAgent, newRequestId } = await import(new URL("agent/agent.mjs", root));
const { canonical } = await import(new URL("api/receipt.mjs", root));

const vector = JSON.parse(readFileSync(new URL("schema/vectors/engine-v3-derived.json", root), "utf8")).vectors[0].envelope;
const green = { ...structuredClone(vector), band: "green", score: 99, caps: [], holds: [] };
const OTHER = "ee".repeat(32);
function record(e) {
  const receipt = canonical(e);
  const d = createHash("sha256").update(receipt).digest("hex");
  return { token_id: e.token_id, seq: Number(e.seq), score: e.score ?? 0, band: e.band, caps: e.caps, holds: e.holds, period: `${e.period_start}/${e.period_end}`, as_of: e.valuation_time, method: e.method_version, version_key: e.engine_version_key, receipt_sha256: d, public_sha256: d, receipt, block_height: 1 };
}
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
      return { request_id: requestId, buyer: "agent.test", kind, query_hash: queryHash, paid: deposit.toString(), created_ns: "1", expires_ns: "2", uses_left: 1 };
    },
  };
}
async function attempt(r, tag) {
  const chain = fakeChain({ [r.token_id]: r });
  const out = await runAgent({ chain, token: r.token_id, receipts: "r.test", query: "q.test", requestId: newRequestId(r.token_id, tag.repeat(12)), nowMs: Date.parse(green.valuation_time), execute: true });
  return { reason: out.decision.reason, bought: chain.bought.length };
}
const committed = await attempt(record(green), "1");
const other = await attempt(record({ ...structuredClone(green), engine_version_key: OTHER, engine_code_sha256: OTHER }), "2");
console.log(JSON.stringify({ build_pin: buildPin, pins: [...PINNED_V3_ENGINES], vector_engine: vector.engine_version_key, committed, other }));
