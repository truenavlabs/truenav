// web/chain.mjs against a mocked JSON-RPC (no network): it builds the engine's TEE store from chain views.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadChainState, view, expiryOf } from "../web/chain.mjs";

const H = "a".repeat(64);
const answers = {
  get_signers: ["0xsigner"], get_tee_signers: [{ address: "0xtee", model_id: "m" }], contract_source_metadata: { link: "x" },
  get_fund: { fund_id: "f" }, get_latest_certificate: null, get_certificate_count: 0, get_attempts_page: { count: 2, attempts: [] }, get_alert_count: 1,
  get_lock: { fund_id: "f", locked_at_ms: 123 }, get_latest_verdict: { verdict: "flag", anomalies: ["amount_mismatch"], at_ms: 456, expires_at_ms: "789" }, get_verdict_count: 2, get_flag_count: 1,
  nft_token: { token_id: H, owner_id: "f.testnet" },
};
function mockFetch(calls) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.params);
    if (body.params.request_type === "view_account") return { ok: true, json: async () => ({ result: { code_hash: "HASH" } }) };
    const out = answers[body.params.method_name];
    const bytes = [...new TextEncoder().encode(JSON.stringify(out))];
    return { ok: true, json: async () => ({ result: { result: bytes } }) };
  };
}

test("loadChainState reads views and builds the TEE store (latest verdict, pledge time)", async () => {
  const calls = [];
  const saved = globalThis.fetch;
  globalThis.fetch = mockFetch(calls);
  try {
    const st = await loadChainState({ funds: ["f"], loans: [{ fund_id: "f", loan_id: "L1", loan_hash: H }], contract: "c.testnet", url: "http://rpc" });
    assert.equal(st.codeHash, "HASH");
    assert.deepEqual(st.teeStore[H], { fund_id: "f", pledged_at_ms: 123, latest: { verdict: "flag", anomalies: ["amount_mismatch"], at_ms: 456, expires_at_ms: 789 } });
    assert.equal(st.funds[0].attempts, 2);
    assert.equal(st.loans[0].holder, "f.testnet");
    assert.ok(calls.every((p) => p.finality === "final"), "reads final state only");
    const lockCall = calls.find((p) => p.method_name === "get_lock");
    assert.equal(JSON.parse(Buffer.from(lockCall.args_base64, "base64").toString()).loan_hash, H);
  } finally {
    globalThis.fetch = saved;
  }
});

test("an RPC error surfaces instead of returning made-up state", async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ error: { message: "boom" } }) });
  try {
    await assert.rejects(view("c.testnet", "get_signers", {}, "http://rpc"), /boom/);
  } finally {
    globalThis.fetch = saved;
  }
});

test("the default RPC falls back to the backups when it fails, an explicit RPC does not", async () => {
  const { DEFAULT_RPC, BACKUP_RPCS } = await import("../web/chain.mjs");
  const saved = globalThis.fetch;
  const hits = [];
  globalThis.fetch = async (url) => {
    hits.push(url);
    if (url === DEFAULT_RPC || url.endsWith("/x")) return { ok: false, status: 429, json: async () => ({}) };
    return { ok: true, json: async () => ({ result: { result: [...new TextEncoder().encode('["0xs"]')] } }) };
  };
  try {
    assert.deepEqual(await view("c.testnet", "get_signers"), ["0xs"]);
    assert.deepEqual(hits, [DEFAULT_RPC, BACKUP_RPCS[0]]);
    hits.length = 0;
    await assert.rejects(view("c.testnet", "get_signers", {}, DEFAULT_RPC + "/x"));
    assert.equal(hits.length, 1);
  } finally {
    globalThis.fetch = saved;
  }
});

// N-02: the loader keeps each latest verdict's expiry, so the scorer can report an expired verdict as expired.
test("expiryOf keeps a numeric or string expiry and drops a missing or bad one", () => {
  assert.deepEqual(expiryOf({ expires_at_ms: 1797016506416 }), { expires_at_ms: 1797016506416 });
  assert.deepEqual(expiryOf({ expires_at_ms: "1797016506416" }), { expires_at_ms: 1797016506416 });
  for (const v of [{}, { expires_at_ms: null }, { expires_at_ms: "soon" }, null]) assert.deepEqual(expiryOf(v), {});
});
