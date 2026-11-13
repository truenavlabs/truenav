// receipts request_run write buttons: arg builders, confirm payload, preflight and outcome parsing.
// The wallet and the views are mocks. No live RPC, no signing, no send.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RECEIPTS_CONTRACT, REGISTRY_CONTRACT, WRITE_METHODS } from "../src/lib/near.mjs";
import {
  REQUEST_RUN,
  REQUEST_RUN_GAS,
  buildRequestRunCall,
  classifyWriteError,
  confirmRows,
  explorerTxUrl,
  isTokenId,
  parseRequestRunOutcome,
  preflightRequestRun,
  requiredDepositYocto,
  sendConfirmedCall,
  withTimeout,
  WalletTimeoutError,
  yoctoToNear,
} from "../src/lib/receipts-write.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, "..", p), "utf8");

// get_config as the live testnet contract returned it on 13 Nov 2026 (receipts.tnlab-718ca9.testnet).
const CONFIG = {
  admin: "tnlab-718ca9.testnet",
  pauser: "tnlab-718ca9.testnet",
  paused: false,
  config: { outlayer: "outlayer.testnet", outlayer_deposit: "10000000000000000000000", storage_deposit: "250000000000000000000000", outlayer_tgas: 230, callback_tgas: 50 },
  next_request: 1,
};
const HASH = "6zgh2u9DqHHiXzdy9ouTP7oGky2T4nugqzqt9wJZwNFm";
const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64");

/** A wallet context sendReceiptsCall that records calls and returns a canned outcome. */
function mockSend(result) {
  const calls = [];
  const send = async (method, args, opts) => {
    calls.push({ method, args, opts });
    if (result instanceof Error) throw result;
    return typeof result === "function" ? result() : result;
  };
  return { send, calls };
}

test("token ids follow the contract's is_token_id rule", () => {
  for (const ok of ["DEMO-CREDIT", "HONEST-RENTAL", "a", "A1-b2-C3", "x".repeat(64)]) assert.equal(isTokenId(ok), true, ok);
  for (const bad of ["", "-A", "A-", "A--B", "A_B", "A B", "A.B", "x".repeat(65), "Ä", null, 1, { token_id: "A" }]) assert.equal(isTokenId(bad), false, String(bad));
});

test("deposit is outlayer_deposit + storage_deposit from get_config, shown in NEAR without rounding", () => {
  assert.equal(requiredDepositYocto(CONFIG), "260000000000000000000000");
  assert.equal(requiredDepositYocto(CONFIG.config), "260000000000000000000000");
  assert.equal(yoctoToNear("260000000000000000000000"), "0.26");
  assert.equal(yoctoToNear("1"), "0.000000000000000000000001");
  assert.equal(yoctoToNear("2000000000000000000000000"), "2");
  assert.throws(() => requiredDepositYocto({ config: { outlayer_deposit: 1, storage_deposit: "2" } }), /get_config/);
  assert.throws(() => requiredDepositYocto(null), /get_config/);
});

test("buildRequestRunCall returns the exact receipts call: token_id only, 300 TGas, 0.26 NEAR", () => {
  const call = buildRequestRunCall({ tokenId: "DEMO-CREDIT", config: CONFIG });
  assert.deepEqual({ ...call, args: { ...call.args } }, {
    receiverId: "receipts.tnlab-718ca9.testnet",
    method: "request_run",
    args: { token_id: "DEMO-CREDIT" },
    argsJson: '{"token_id":"DEMO-CREDIT"}',
    gas: "300000000000000",
    gasTgas: 300,
    depositYocto: "260000000000000000000000",
    depositNear: "0.26",
  });
  assert.equal(Object.isFrozen(call), true);
  assert.equal(Object.isFrozen(call.args), true);
  // the contract needs prepaid gas >= outlayer_tgas + callback_tgas + 10
  assert.ok(BigInt(REQUEST_RUN_GAS) >= BigInt(CONFIG.config.outlayer_tgas + CONFIG.config.callback_tgas + 10) * 10n ** 12n);
});

test("the builder refuses bad token ids and deposits above the request_run cap", () => {
  assert.throws(() => buildRequestRunCall({ tokenId: "bad id", config: CONFIG }), /token_id must/);
  const huge = { config: { outlayer_deposit: "10000000000000000000000", storage_deposit: "500000000000000000000000" } };
  assert.throws(() => buildRequestRunCall({ tokenId: "DEMO-CREDIT", config: huge }), /above the cap/);
});

test("the confirm rows show receiver, method, args JSON, gas and deposit in NEAR exactly as sent", () => {
  const call = buildRequestRunCall({ tokenId: "HONEST-CREDIT", config: CONFIG });
  const rows = Object.fromEntries(confirmRows(call));
  assert.equal(rows.Receiver, RECEIPTS_CONTRACT);
  assert.equal(rows.Method, "request_run");
  assert.equal(rows["Args (JSON)"], '{"token_id":"HONEST-CREDIT"}');
  assert.match(rows.Gas, /^300 TGas \(300000000000000 gas units\)$/);
  assert.match(rows.Deposit, /^0\.26 NEAR \(260000000000000000000000 yoctoNEAR\)/);
  assert.equal(rows.Network, "NEAR testnet");
});

test("sendConfirmedCall sends exactly the confirmed call through sendReceiptsCall", async () => {
  const call = buildRequestRunCall({ tokenId: "DEMO-CREDIT", config: CONFIG });
  const w = mockSend({ status: { SuccessValue: b64("stored:1") }, transaction: { hash: HASH }, receipts_outcome: [] });
  const out = await sendConfirmedCall(w.send, call);
  assert.deepEqual(w.calls, [{ method: "request_run", args: { token_id: "DEMO-CREDIT" }, opts: { gas: "300000000000000", depositYocto: "260000000000000000000000" } }]);
  assert.equal(out.kind, "stored");
  assert.equal(out.hash, HASH);
  assert.equal(out.explorerUrl, `https://testnet.nearblocks.io/txns/${HASH}`);
});

test("nothing can target a non-receipts receiver or a method off the allowlist", async () => {
  const good = buildRequestRunCall({ tokenId: "DEMO-CREDIT", config: CONFIG });
  for (const receiverId of [REGISTRY_CONTRACT, " receipts.tnlab-718ca9.testnet", "Receipts.tnlab-718ca9.testnet", "x.receipts.tnlab-718ca9.testnet", "evil.testnet", "query.tnlab-718ca9.testnet", undefined]) {
    const w = mockSend({});
    const out = await sendConfirmedCall(w.send, { ...good, receiverId });
    assert.equal(out.kind, "guard", String(receiverId));
    assert.equal(w.calls.length, 0, String(receiverId));
  }
  for (const method of ["set_runner", "register_token", "clear_pending", "pledge_loan", "buy_query", ""]) {
    const w = mockSend({});
    const out = await sendConfirmedCall(w.send, { ...good, method });
    assert.equal(out.kind, "guard", method);
    assert.equal(w.calls.length, 0, method);
  }
  assert.deepEqual(Object.keys(WRITE_METHODS), [REQUEST_RUN]);
});

test("the wallet context's sendReceiptsCall pins the receiver to RECEIPTS_CONTRACT, and pages never name a receiver", () => {
  const shell = read("src/shell/wallet.tsx");
  assert.match(shell, /buildSignAndSendTransaction\(\{ receiverId: RECEIPTS_CONTRACT, methodName: method/);
  assert.match(shell, /signAndSendTransaction\(\{ network: WALLET_NETWORK, signerId: signedAccountId, receiverId: RECEIPTS_CONTRACT/);
  for (const f of ["src/lib/useReceiptsRun.ts", "src/shell/ReceiptRunAction.tsx", "src/depth/impl.tsx"]) {
    const s = read(f);
    assert.equal(/signAndSendTransaction|registry\.tnlab|getWalletConnector|REGISTRY_CONTRACT|receiverId:\s*["'`]/.test(s), false, f);
  }
  const view = read("src/shell/ReceiptRunAction.tsx");
  assert.match(view, /useReceiptsRun\(\{ accountId: signedAccountId, sendReceiptsCall \}\)/);
});

test("preflight passes only for a runner, an unpaused contract and a registered token with no pending run", async () => {
  const views = (over = {}) => {
    const seen = [];
    const v = async (m, a) => {
      seen.push([m, a]);
      if (m === "get_config") return over.config ?? CONFIG;
      if (m === "is_runner") return over.runner ?? true;
      if (m === "get_token") return "token" in over ? over.token : { token: { token_id: a.token_id }, pending: null, last_failure: null };
      throw new Error("unexpected view " + m);
    };
    return { v, seen };
  };
  const ok = views();
  const r = await preflightRequestRun({ accountId: "runner.tnlab-718ca9.testnet", tokenId: "DEMO-CREDIT", view: ok.v });
  assert.equal(r.ok, true);
  assert.equal(r.call.receiverId, RECEIPTS_CONTRACT);
  assert.deepEqual(ok.seen.map((s) => s[0]).sort(), ["get_config", "get_token", "is_runner"]);
  assert.deepEqual(ok.seen.find((s) => s[0] === "is_runner")[1], { account: "runner.tnlab-718ca9.testnet" });

  const notRunner = await preflightRequestRun({ accountId: "alice.testnet", tokenId: "DEMO-CREDIT", view: views({ runner: false }).v });
  assert.equal(notRunner.ok, false);
  assert.equal(notRunner.call, null);
  assert.match(notRunner.reasons.join(" "), /not a runner.*runner only/);

  assert.match((await preflightRequestRun({ accountId: "a.testnet", tokenId: "DEMO-CREDIT", view: views({ config: { ...CONFIG, paused: true } }).v })).reasons.join(" "), /paused/);
  assert.match((await preflightRequestRun({ accountId: "a.testnet", tokenId: "NOPE", view: views({ token: null }).v })).reasons.join(" "), /not registered/);
  assert.match((await preflightRequestRun({ accountId: "a.testnet", tokenId: "DEMO-CREDIT", view: views({ token: { token: {}, pending: { request_id: 4 } } }).v })).reasons.join(" "), /already pending.*request 4/);
  assert.match((await preflightRequestRun({ accountId: "", tokenId: "DEMO-CREDIT", view: ok.v })).reasons[0], /Connect/);
});

test("outcomes: stored, run failure, contract refusal, submitted, and no hash", () => {
  const refused = parseRequestRunOutcome({
    status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: runner only" } } } } },
    transaction: { hash: HASH },
  });
  assert.equal(refused.kind, "refused");
  assert.equal(refused.detail, "runner only");
  assert.equal(refused.explorerUrl, `https://testnet.nearblocks.io/txns/${HASH}`);

  assert.equal(parseRequestRunOutcome({ status: { SuccessValue: b64("module_failed:fetch") }, transaction: { hash: HASH } }).kind, "run_failed");
  assert.equal(parseRequestRunOutcome({ status: { SuccessValue: b64({ error: "v2_receipt_corrupt", head_status: "failed" }) }, transaction: { hash: HASH } }).kind, "run_failed");

  const ev = `EVENT_JSON:${JSON.stringify({ standard: "truenav-receipts", version: "1", event: "run_requested", data: [{ token_id: "DEMO-CREDIT", request_id: 1 }] })}`;
  const sub = parseRequestRunOutcome({ status: { SuccessValue: "" }, transaction: { hash: HASH }, receipts_outcome: [{ outcome: { logs: ["plain", ev] } }] });
  assert.equal(sub.kind, "submitted");
  assert.match(sub.detail, /request 1/);
  assert.deepEqual(sub.events, [{ event: "run_requested", data: { token_id: "DEMO-CREDIT", request_id: 1 } }]);

  assert.equal(parseRequestRunOutcome({ transaction_outcome: { id: HASH } }).kind, "submitted");
  const none = parseRequestRunOutcome(undefined);
  assert.equal(none.kind, "unknown");
  assert.equal(none.hash, null);
});

test("explorer links only for base58 hashes", () => {
  assert.equal(explorerTxUrl(HASH), `https://testnet.nearblocks.io/txns/${HASH}`);
  for (const bad of ["", "abc", "javascript:alert(1)", HASH + "/../x", "0OIl".repeat(11), null]) assert.equal(explorerTxUrl(bad), null, String(bad));
  assert.equal(parseRequestRunOutcome({ status: { SuccessValue: b64("stored:2") }, transaction: { hash: "<img>" } }).hash, null);
});

test("wallet reject, error and timeout come back as clean states, not throws", async () => {
  const call = buildRequestRunCall({ tokenId: "DEMO-CREDIT", config: CONFIG });
  const rejected = await sendConfirmedCall(mockSend(new Error("User rejected the request")).send, call);
  assert.deepEqual(rejected, { kind: "rejected", message: "You rejected the request in the wallet. Nothing was sent." });
  const failed = await sendConfirmedCall(mockSend(new Error("RPC 502")).send, call);
  assert.deepEqual(failed, { kind: "error", message: "RPC 502" });

  // fake timers: the wallet never answers
  let fire;
  const timers = { set: (fn) => ((fire = fn), 1), clear: () => {} };
  const pending = sendConfirmedCall(() => new Promise(() => {}), call, { timeoutMs: 180000, timers });
  await new Promise((r) => setImmediate(r));
  fire();
  const timedOut = await pending;
  assert.equal(timedOut.kind, "timeout");
  assert.match(timedOut.message, /180 s.*may still land/);

  assert.equal(classifyWriteError(new WalletTimeoutError(1000)).kind, "timeout");
  assert.equal(classifyWriteError(new Error("Writes go to the receipts contract only")).kind, "guard");
  assert.equal(classifyWriteError(undefined).kind, "error");
  assert.equal(await withTimeout(Promise.resolve(5), 10), 5);
});
