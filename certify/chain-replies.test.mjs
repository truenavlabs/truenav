// The CI check on live chain data (owner decisions 7 Nov, D4): every submit_verdict call that reaches the contract
// is found, including calls through another contract and delegated (meta) transactions; only calls from our own
// accounts can fail the check, foreign ones are warnings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { verdictCalls, callProblem, isOurs } from "./check-chain-replies.mjs";

const C = "registry.tnlab-x.testnet";
const args = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const fc = (method, a) => ({ FunctionCall: { method_name: method, args: a, gas: 1, deposit: "1" } });
const receipt = (receiver, predecessor, signer, actions) => ({ receipt: { receiver_id: receiver, predecessor_id: predecessor, receipt: { Action: { signer_id: signer, actions } } } });
const tx = (hash, signer, receiver, actions, receipts) => ({ transaction: { hash, signer_id: signer, receiver_id: receiver, actions }, receipts });

test("a direct call is found once, from its receipt", () => {
  const a = args({ response_body: "x" });
  const t = tx("T1", "servicer.tnlab-x.testnet", C, [fc("submit_verdict", a)], [receipt(C, "servicer.tnlab-x.testnet", "servicer.tnlab-x.testnet", [fc("submit_verdict", a)])]);
  assert.deepEqual(verdictCalls(t, C).map((c) => [c.tx, c.signer]), [["T1", "servicer.tnlab-x.testnet"]]);
});

test("a call that comes through another contract is found (tx receiver is not the registry)", () => {
  const t = tx("T2", "mallory.testnet", "proxy.mallory.testnet", [fc("relay", args({}))], [
    receipt("proxy.mallory.testnet", "mallory.testnet", "mallory.testnet", [fc("relay", args({}))]),
    receipt(C, "proxy.mallory.testnet", "mallory.testnet", [fc("submit_verdict", args({ response_body: "leak" }))]),
  ]);
  const calls = verdictCalls(t, C);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].predecessor, "proxy.mallory.testnet");
});

test("a delegated (meta) transaction's inner call is found through its receipt", () => {
  const t = tx("T3", "relayer.testnet", "servicer.tnlab-x.testnet", [{ Delegate: {} }], [receipt(C, "servicer.tnlab-x.testnet", "relayer.testnet", [fc("submit_verdict", args({ response_body: "x" }))])]);
  assert.equal(verdictCalls(t, C).length, 1);
});

test("a transaction not yet executed falls back to its own actions; other methods are ignored", () => {
  assert.equal(verdictCalls(tx("T4", "s.testnet", C, [fc("submit_verdict", args({})), fc("pledge_loan", args({}))], []), C).length, 1);
  assert.equal(verdictCalls(tx("T5", "s.testnet", C, [fc("pledge_loan", args({}))], [receipt(C, "s.testnet", "s.testnet", [fc("pledge_loan", args({}))])]), C).length, 0);
});

test("our accounts: the parent account, its sub-accounts and the role holders; anything else is foreign", () => {
  const roles = ["truenav-admin.testnet", "servicer.tnlab-x.testnet"];
  assert.ok(isOurs("tnlab-x.testnet", "tnlab-x.testnet", roles));
  assert.ok(isOurs("meridian.tnlab-x.testnet", "tnlab-x.testnet", roles));
  assert.ok(isOurs("truenav-admin.testnet", "tnlab-x.testnet", roles));
  assert.ok(!isOurs("mallory.testnet", "tnlab-x.testnet", roles));
  assert.ok(!isOurs("eviltnlab-x.testnet", "tnlab-x.testnet", roles));
  assert.ok(!isOurs(undefined, "tnlab-x.testnet", roles));
});

test("arguments that are not JSON or have no response_body are problems", () => {
  assert.equal(callProblem(Buffer.from("not json").toString("base64")), "arguments are not JSON");
  assert.equal(callProblem(args({ loan_hash: "x" })), "no response_body");
  assert.match(callProblem(args({ response_body: "{}" })), /choice/);
});
