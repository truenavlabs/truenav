// The CI check on live chain data (owner decisions 7 Nov, D4): every submit_verdict call that reaches the contract
// is found, including calls through another contract and delegated (meta) transactions; only calls from our own
// accounts can fail the check, foreign ones are warnings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { verdictCalls, callProblem, isOurs, judgeCall, outcomeOf } from "./check-chain-replies.mjs";
import { readFileSync } from "node:fs";

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

// The shape rule fails every call; the N-04 consistency rule fails a call that succeeded, warns on a call refused on
// chain, and fails when the outcome cannot be read. The real refused call from the earlier instance is the fixture.
const refused = JSON.parse(readFileSync(new URL("./fixtures/refused-call-2Jm59t8.json", import.meta.url), "utf8"));
const realTx = (status) => ({
  transaction: { hash: refused.tx, signer_id: refused.signer, receiver_id: refused.contract, actions: [fc("submit_verdict", refused.args_base64)] },
  receipts: [{ ...receipt(refused.contract, refused.predecessor, refused.signer, [fc("submit_verdict", refused.args_base64)]), execution_outcome: { outcome: { status } } }],
});

test("the real refused reply from 2Jm59t8... with its Failure outcome warns and does not fail", () => {
  assert.ok("Failure" in refused.status);
  const [c] = verdictCalls(realTx(refused.status), refused.contract);
  assert.equal(c.outcome, "failure");
  assert.equal(callProblem(c.args), null, "its keys and shape are clean");
  const j = judgeCall(c);
  assert.equal(j.level, "warn");
  assert.match(j.problem, /a pass needs all six checks ok; amount_mismatch is "fail" \(refused on chain\)/);
});

test("the same reply with a success outcome fails, and with an unreadable outcome fails", () => {
  for (const status of [{ SuccessValue: "" }, { SuccessReceiptId: "x" }]) {
    const [c] = verdictCalls(realTx(status), refused.contract);
    assert.deepEqual([c.outcome, judgeCall(c).level], ["success", "fail"]);
  }
  for (const status of [undefined, null, {}, { Unknown: 1 }]) {
    const [c] = verdictCalls(realTx(status), refused.contract);
    const j = judgeCall(c);
    assert.equal(c.outcome, "unknown");
    assert.equal(j.level, "fail");
    assert.match(j.problem, /outcome could not be read/);
  }
  // a transaction with no receipts yet has no readable outcome either
  const t = realTx(refused.status);
  t.receipts = [];
  const [c] = verdictCalls(t, refused.contract);
  assert.deepEqual([c.outcome, judgeCall(c).level], ["unknown", "fail"]);
});

test("a shape problem fails even on a call refused on chain", () => {
  const body = JSON.parse(JSON.parse(Buffer.from(refused.args_base64, "base64")).response_body);
  body.system_fingerprint = "fp";
  const a = args({ response_body: JSON.stringify(body) });
  assert.equal(judgeCall({ args: a, outcome: "failure" }).level, "fail");
  assert.match(judgeCall({ args: a, outcome: "failure" }).problem, /outside the allowed list: system_fingerprint/);
});

test("outcomeOf reads the receipt status", () => {
  assert.equal(outcomeOf({ Failure: {} }), "failure");
  assert.equal(outcomeOf({ SuccessValue: "" }), "success");
  assert.equal(outcomeOf({ SuccessReceiptId: "r" }), "success");
  assert.equal(outcomeOf(undefined), "unknown");
});

// The CLI's exit code on the real refused reply, against a local fake indexer and RPC (no network).
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

async function runCli(status) {
  const t = realTx(status);
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/v0/account") return res.end(JSON.stringify({ account_txs: [{ transaction_hash: refused.tx }] }));
      if (req.url === "/v0/transactions") return res.end(JSON.stringify({ transactions: [t] }));
      const j = JSON.parse(body || "{}"); // RPC: get_roles
      const roles = { admin: "tnlab-718ca9.testnet", registrar: "tnlab-718ca9.testnet", pauser: "pauser.tnlab-718ca9.testnet", servicer: refused.signer, paused: false };
      res.end(JSON.stringify({ jsonrpc: "2.0", id: j.id, result: { result: [...Buffer.from(JSON.stringify(roles))] } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    return await new Promise((resolve) => {
      const p = spawn(process.execPath, [fileURLToPath(new URL("./check-chain-replies.mjs", import.meta.url)), "--contract", refused.contract], { env: { PATH: process.env.PATH, TRUENAV_TX_API: url, TRUENAV_RPC: url } });
      let out = "";
      p.stdout.on("data", (c) => (out += c));
      p.stderr.on("data", (c) => (out += c));
      p.on("close", (code) => resolve({ code, out }));
    });
  } finally { server.close(); }
}

test("CLI: the real reply refused on chain prints WARN <tx> (refused on chain) and exits 0", async () => {
  const r = await runCli(refused.status);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`^WARN ${refused.tx} \\(refused on chain\\)`, "m"));
  assert.doesNotMatch(r.out, /^FAIL/m);
});

test("CLI: the same reply with a success outcome exits 1", async () => {
  const r = await runCli({ SuccessValue: "" });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, new RegExp(`^FAIL ${refused.tx} from ${refused.signer.replace(/\./g, "\\.")}: a pass needs all six checks ok`, "m"));
});
