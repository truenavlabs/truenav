// web/chain.mjs RPC failover with a per-endpoint timeout. Fake fetch only, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKUP_RPCS, DEFAULT_RPC, RPC_TIMEOUT_MS, rpcCall } from "../chain.mjs";

const hang = (seen) => (url, init) => {
  seen.push(url);
  return new Promise((_ok, no) => init.signal.addEventListener("abort", () => no(Object.assign(new Error("aborted"), { name: init.signal.reason?.name || "AbortError" }))));
};

test("the per-endpoint timeout is 8 seconds", () => {
  assert.equal(RPC_TIMEOUT_MS, 8000);
});

test("a hung default endpoint times out and the failover answers", async () => {
  const seen = [];
  const h = hang(seen);
  const fetchImpl = (url, init) => (url === DEFAULT_RPC ? h(url, init) : (seen.push(url), Promise.resolve({ ok: true, status: 200, json: async () => ({ result: { ok: url } }) })));
  const t0 = Date.now();
  const res = await rpcCall(DEFAULT_RPC, "status", {}, { fetchImpl, timeoutMs: 50 });
  assert.deepEqual(res, { ok: BACKUP_RPCS[0] });
  assert.deepEqual(seen, [DEFAULT_RPC, BACKUP_RPCS[0]]);
  assert.ok(Date.now() - t0 < 2000);
});

test("when every endpoint hangs the error is a short timeout message, not a stack", async () => {
  const seen = [];
  await assert.rejects(rpcCall(DEFAULT_RPC, "status", {}, { fetchImpl: hang(seen), timeoutMs: 20 }), /^Error: RPC status timed out after 20 ms$/);
  assert.equal(seen.length, 1 + BACKUP_RPCS.length);
});

test("an explicit endpoint does not fall back, and a contract error is not hidden", async () => {
  const seen = [];
  await assert.rejects(rpcCall("http://127.0.0.1:1/", "status", {}, { fetchImpl: hang(seen), timeoutMs: 20 }), /timed out/);
  assert.equal(seen.length, 1);
  const calls = [];
  const contractErr = async (url) => (calls.push(url), { ok: true, status: 200, json: async () => ({ error: { name: "HANDLER_ERROR", message: "wasm execution failed" } }) });
  await assert.rejects(rpcCall(DEFAULT_RPC, "query", {}, { fetchImpl: contractErr }), /wasm execution failed/);
  assert.equal(calls.length, 1);
});
