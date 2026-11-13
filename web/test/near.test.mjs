// near-api-js helpers: view calls and FunctionCall payloads. No live RPC, no signing, no send.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BACKUP_RPC_URLS,
  CONTRACTS,
  NETWORK,
  RECEIPTS_CONTRACT,
  REGISTRY_CONTRACT,
  RPC_URL,
  buildSignAndSendTransaction,
  defaultGas,
  functionCallAction,
  isRegistryWriteBlocked,
  viewFunction,
  yoctoDeposit,
  MAX_DEPOSIT_YOCTO,
  MAX_GAS,
  WRITE_METHODS,
} from "../src/lib/near.mjs";

test("helpers are pinned to testnet and the existing contract ids", () => {
  assert.equal(NETWORK, "testnet");
  assert.equal(RPC_URL, "https://test.rpc.fastnear.com");
  assert.ok(BACKUP_RPC_URLS.includes("https://near-testnet.drpc.org"));
  assert.equal(REGISTRY_CONTRACT, "registry.tnlab-368aa2.testnet");
  assert.equal(RECEIPTS_CONTRACT, "receipts.tnlab-718ca9.testnet");
  assert.equal(CONTRACTS.registry, REGISTRY_CONTRACT);
  assert.equal(CONTRACTS.receipts, RECEIPTS_CONTRACT);
  assert.equal(isRegistryWriteBlocked(REGISTRY_CONTRACT), true);
  assert.equal(isRegistryWriteBlocked(RECEIPTS_CONTRACT), false);
});

test("default gas is 30 TGas and zero deposit is 0 yocto, from near-api-js units", () => {
  assert.equal(defaultGas(), "30000000000000");
  assert.equal(yoctoDeposit("0"), "0");
  assert.equal(yoctoDeposit("1"), "1000000000000000000000000");
});

test("functionCallAction uses the near-connect FunctionCall shape from docs.near.org", () => {
  const action = functionCallAction("get_fund", { fund_id: "harbor-credit-fund" });
  assert.deepEqual(action, {
    type: "FunctionCall",
    params: {
      methodName: "get_fund",
      args: { fund_id: "harbor-credit-fund" },
      gas: "30000000000000",
      deposit: "0",
    },
  });
});

test("buildSignAndSendTransaction refuses a write to the live registry and does not sign", () => {
  assert.throws(
    () => buildSignAndSendTransaction({ receiverId: REGISTRY_CONTRACT, methodName: "request_run", args: {} }),
    /receipts contract only/,
  );
  const payload = buildSignAndSendTransaction({
    receiverId: RECEIPTS_CONTRACT,
    methodName: "request_run",
    args: { token_id: "demo" },
    gas: "40000000000000",
    depositYocto: "1",
  });
  assert.deepEqual(payload, {
    receiverId: RECEIPTS_CONTRACT,
    actions: [
      {
        type: "FunctionCall",
        params: { methodName: "request_run", args: { token_id: "demo" }, gas: "40000000000000", deposit: "1" },
      },
    ],
  });
  assert.equal(JSON.stringify(payload).includes("sign"), false);
});

test("the write guard is an allowlist: only the exact receipts id is a receiver", () => {
  for (const receiverId of [
    "registry.tnlab-718ca9.testnet",
    " registry.tnlab-368aa2.testnet",
    "Registry.tnlab-368aa2.testnet",
    "x.registry.tnlab-368aa2.testnet",
    "evil.testnet",
    " receipts.tnlab-718ca9.testnet",
    "RECEIPTS.tnlab-718ca9.testnet",
    "x.receipts.tnlab-718ca9.testnet",
    "receipts.tnlab-718ca9.testnet.",
    "",
    undefined,
  ]) {
    assert.throws(() => buildSignAndSendTransaction({ receiverId, methodName: "request_run" }), /receipts contract only/, String(receiverId));
  }
});

test("the write guard refuses methods off the list, oversized gas or deposit, and non-digit strings", () => {
  const base = { receiverId: RECEIPTS_CONTRACT, methodName: "request_run", args: { token_id: "t" } };
  for (const methodName of ["set_config", "set_runner", "propose_admin", "pause", "request_mirror", "toString", "__proto__", "", 1]) {
    assert.throws(() => buildSignAndSendTransaction({ ...base, methodName }), /not allowed/, String(methodName));
  }
  assert.ok(buildSignAndSendTransaction({ ...base, gas: String(MAX_GAS) }));
  assert.throws(() => buildSignAndSendTransaction({ ...base, gas: String(MAX_GAS + 1n) }), /300 TGas/);
  assert.throws(() => buildSignAndSendTransaction({ ...base, gas: "0" }), /300 TGas/);
  const cap = WRITE_METHODS.request_run.maxDepositYocto;
  assert.ok(buildSignAndSendTransaction({ ...base, depositYocto: String(cap) }));
  assert.throws(() => buildSignAndSendTransaction({ ...base, depositYocto: String(cap + 1n) }), /above the cap/);
  for (const bad of ["1e24", "0x10", " 1", "1 ", "-1", "1.5", "01", "", "abc", 1]) {
    assert.throws(() => buildSignAndSendTransaction({ ...base, gas: bad }), /digit string|300 TGas/, `gas ${bad}`);
    assert.throws(() => buildSignAndSendTransaction({ ...base, depositYocto: bad }), /digit string/, `deposit ${bad}`);
  }
  assert.throws(() => buildSignAndSendTransaction({ ...base, deposit: "1" }), /depositYocto/);
  assert.throws(() => buildSignAndSendTransaction({ ...base, args: [] }), /plain object/);
  assert.equal(MAX_DEPOSIT_YOCTO, 10n ** 23n);
  assert.equal(yoctoDeposit("0.1"), String(MAX_DEPOSIT_YOCTO));
});

test("viewFunction uses the injected provider and never calls a live RPC", async () => {
  const calls = [];
  const provider = {
    callFunction: async (opts) => {
      calls.push(opts);
      return { fund_id: opts.args.fund_id, ok: true };
    },
  };
  const result = await viewFunction({
    contractId: REGISTRY_CONTRACT,
    method: "get_fund",
    args: { fund_id: "harbor-credit-fund" },
    provider,
  });
  assert.deepEqual(result, { fund_id: "harbor-credit-fund", ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].contractId, REGISTRY_CONTRACT);
  assert.equal(calls[0].method, "get_fund");
});
