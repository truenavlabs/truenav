// Step 4 end to end on a local NEAR sandbox node (no testnet, no OutLayer, no network after the sandbox binary is
// downloaded): the receipt contract, the query contract and a mock OutLayer (receipts/mock-outlayer, yield and
// resume like request_execution) are deployed; for each synthetic fund a runner calls request_run, the harness acts
// as the OutLayer worker by running the real engine natively (outlayer/engine-v2 examples/native.rs, the same
// tee::execute as the wasm) on the request's public input, and resolves the yield. Then the API is started against
// the sandbox and an agent buys and spends entitlements.
//
//   npm run e2e:receipts   (builds the three contract wasms and the native engine first if missing)
//
// The sandbox root account uses the development key published in the near-sandbox package; it controls only this
// throwaway local chain. Sub-account keys live in a temporary keychain that is deleted afterwards.
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from "near-sandbox";
import { Account, JsonRpcProvider, KeyPair, actions, baseEncode, nearToYocto, teraToGas } from "near-api-js";
import { createServer, queryHash } from "../../api/server.mjs";
import { nearChain } from "../../api/chain.mjs";
import { RUN_AS_OF, BANK_FETCHED_AT } from "../../cashflow/demo/data.mjs";
import { severeArrears } from "../tests/arrears.mjs";
import { runAgent, summary, newRequestId, queryHash as agentQueryHash } from "../../agent/agent.mjs";
import { agentChain } from "../../agent/chain.mjs";

const root = new URL("../../", import.meta.url).pathname;
const wasm = (crate, name) => join(root, crate, `target/near/${name}.wasm`);
const builds = [["receipts", "truenav_receipts"], ["query", "truenav_query"], ["receipts/mock-outlayer", "mock_outlayer"]];
for (const [crate, name] of builds) if (!existsSync(wasm(crate, name))) execSync("cargo near build non-reproducible-wasm --locked", { cwd: join(root, crate), stdio: "inherit" });
const engine = join(root, "outlayer/engine-v2/target/debug/examples/native");
if (!existsSync(engine)) execSync("cargo build --locked --example native", { cwd: join(root, "outlayer/engine-v2"), stdio: "inherit" });
const PIN = readFileSync(join(root, "outlayer/engine-v2/BUILD.md"), "utf8").match(/^\| wasm sha256 \| `([0-9a-f]{64})`/m)[1];

let failures = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${what}`);
  if (!cond) failures++;
};

const sandbox = await Sandbox.start({});
const keys = mkdtempSync(join(tmpdir(), "truenav-receipts-keys-"));
let server;
try {
  const provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
  const rootAcc = new Account(DEFAULT_ACCOUNT_ID, provider, DEFAULT_PRIVATE_KEY);
  const id = (n) => `${n}.${DEFAULT_ACCOUNT_ID}`;
  const accounts = {};
  for (const [n, near] of [["admin", "20"], ["pauser", "5"], ["runner", "20"], ["worker", "5"], ["api", "5"], ["agent", "5"], ["receipts", "30"], ["query", "10"], ["outlayer", "10"]]) {
    const kp = KeyPair.fromRandom("ed25519");
    writeFileSync(join(keys, `${id(n)}.json`), JSON.stringify({ account_id: id(n), private_key: kp.toString() }), { mode: 0o600 });
    await rootAcc.signAndSendTransaction({ receiverId: id(n), actions: [actions.createAccount(), actions.transfer(nearToYocto(near)), actions.addFullAccessKey(kp.getPublicKey())], waitUntil: "FINAL" });
    accounts[n] = new Account(id(n), provider, kp.toString());
  }
  const status = (tx) => (tx.status && tx.status.SuccessValue !== undefined ? { ok: true, value: tx.status.SuccessValue ? JSON.parse(Buffer.from(tx.status.SuccessValue, "base64").toString()) : null } : { ok: false, failure: JSON.stringify(tx.status && tx.status.Failure) });
  const call = async (who, contract, method, args, { gas = "100", deposit = 0n, wait = "FINAL" } = {}) => status(await accounts[who].signAndSendTransaction({ receiverId: id(contract), actions: [actions.functionCall(method, args, teraToGas(gas), deposit)], throwOnFailure: false, waitUntil: wait }));
  const view = (contract, method, args = {}) => provider.callFunction({ contractId: id(contract), method, args, blockQuery: { finality: "final" } });
  const deploy = async (n, file, init, args) => status(await accounts[n].signAndSendTransaction({ receiverId: id(n), actions: [actions.deployContract(new Uint8Array(readFileSync(file))), actions.functionCall(init, args, teraToGas("50"), 0n)], waitUntil: "FINAL" }));

  // ---- deploy ------------------------------------------------------------------------------------------------
  const config = {
    outlayer: id("outlayer"), project_id: `${id("receipts")}/truenav-engine`, version_key: PIN, method: "cashflow-v2.1.0", secrets_profile: "engine", secrets_owner: id("receipts"),
    max_instructions: 10_000_000_000, max_memory_mb: 128, max_execution_seconds: 30,
    outlayer_deposit: nearToYocto("0.01").toString(), storage_deposit: nearToYocto("0.25").toString(), outlayer_tgas: 230, callback_tgas: 50,
  };
  ok((await deploy("outlayer", wasm("receipts/mock-outlayer", "mock_outlayer"), "new", { worker: id("worker") })).ok, "mock OutLayer deployed");
  ok((await deploy("receipts", wasm("receipts", "truenav_receipts"), "new", { admin: id("admin"), pauser: id("pauser"), config })).ok, "receipt contract deployed");
  ok((await deploy("query", wasm("query", "truenav_query"), "new", { admin: id("admin"), redeemer: id("api"), fee: nearToYocto("0.01").toString() })).ok, "query contract deployed");
  ok((await call("admin", "receipts", "set_runner", { account: id("runner"), allowed: true }, { deposit: 1n })).ok, "runner set (admin, 1 yocto)");
  const funds = { "DEMO-CREDIT": "credit", "DEMO-RENTAL": "rental", "HONEST-CREDIT": "credit", "HONEST-RENTAL": "rental" };
  for (const [t, k] of Object.entries(funds)) await call("admin", "receipts", "register_token", { token_id: t, kind: k }, { deposit: 1n });
  ok((await call("admin", "receipts", "set_runner", { account: id("agent"), allowed: true })).ok === false, "an admin call without 1 yocto is refused");
  // D1 funds receipts. with FUND.receipts (receipts/deploy-testnet.mjs); after deploy, init and the 4 tokens (D2, D3)
  // the locked storage must leave at least 0.1 NEAR for gas and for refunds paid from the contract's own balance
  const fundReceipts = nearToYocto(readFileSync(join(root, "receipts/deploy-testnet.mjs"), "utf8").match(/receipts: "([0-9.]+)"/)[1]);
  const rAcct = await provider.viewAccount({ accountId: id("receipts"), blockQuery: { finality: "final" } });
  const locked = BigInt(rAcct.storage_usage) * 10n ** 19n;
  ok(locked + nearToYocto("0.1") <= fundReceipts, `receipts storage after D2 and D3: ${rAcct.storage_usage} bytes, ${(Number(locked) / 1e24).toFixed(4)} NEAR locked of the ${(Number(fundReceipts) / 1e24).toFixed(1)} NEAR D1 funds it`);

  const datasets = Object.fromEntries(Object.keys(funds).map((t) => [t, JSON.parse(readFileSync(join(root, `cashflow/fixtures/parity/cashflow-parity-${t}.json`))).input.dataset]));
  const dsFile = (t, ds) => {
    const f = join(keys, `ds-${t}-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(f, JSON.stringify(ds));
    return f;
  };
  // the worker: wait for the open request, run the engine on its public input, resolve the yield
  // the clock and as_of are the synthetic data's real run time (8 Nov 2026), as in the parity fixtures
  async function serve(token, { ds = datasets[token], tamper, fail } = {}) {
    for (let i = 0; i < 60; i++) {
      const open = (await view("outlayer", "get_requests")).filter((r) => JSON.parse(r.input_data).token_id === token);
      if (open.length) {
        const r = open[0];
        let out = fail ? "" : execFileSync(engine, [dsFile(token, ds), BANK_FETCHED_AT], { input: JSON.stringify({ ...JSON.parse(r.input_data), as_of: RUN_AS_OF }) }).toString();
        if (tamper) out = tamper(out);
        const res = await call("worker", "outlayer", "resolve", { request_id: r.request_id, success: !fail, output: out });
        if (process.env.E2E_DEBUG) console.log("  resolve", r.request_id, res.ok ? "ok" : res.failure.slice(0, 300), `after ${i * 0.5}s`);
        return r;
      }
      await new Promise((res) => setTimeout(res, 500));
    }
    throw new Error(`no request for ${token}`);
  }
  // request_run stays open until the yield resumes, so it is sent without waiting and checked after resolve
  async function run(token, opts) {
    // signed once, hash computed locally, broadcast without waiting (the call stays open until the yield resumes)
    const signed = await accounts.runner.createSignedTransaction({ receiverId: id("receipts"), actions: [actions.functionCall("request_run", { token_id: token }, teraToGas("300"), nearToYocto("0.26"))] });
    const hash = baseEncode(createHash("sha256").update(signed.transaction.encode()).digest());
    await provider.sendTransactionAsync(signed);
    // refused at admission: there is no open request to serve
    const req = opts && opts.refused ? null : await serve(token, opts);
    for (let i = 0; i < 60; i++) {
      try {
        const t = await provider.viewTransactionStatusWithReceipts({ txHash: hash, accountId: id("runner"), waitUntil: "FINAL" });
        if (t.status && (t.status.SuccessValue !== undefined || t.status.Failure)) {
          if (process.env.E2E_DEBUG) for (const ro of t.receipts_outcome) if (ro.outcome.status.Failure) console.log("  receipt failure", ro.outcome.executor_id, JSON.stringify(ro.outcome.status.Failure).slice(0, 400));
          return { req, result: status(t) };
        }
      } catch {
        // not final yet
      }
      await new Promise((res) => setTimeout(res, 500));
    }
    throw new Error(`request_run for ${token} not final`);
  }

  // ---- runs --------------------------------------------------------------------------------------------------
  const expect = { "DEMO-CREDIT": [58, "red"], "DEMO-RENTAL": [58, "red"], "HONEST-CREDIT": [100, "green"], "HONEST-RENTAL": [100, "green"] };
  for (const [t, [score, band]] of Object.entries(expect)) {
    const before = BigInt((await provider.viewAccount({ accountId: id("runner"), blockQuery: { finality: "final" } })).amount);
    const { req, result } = await run(t);
    const input = JSON.parse(req.input_data);
    ok(Object.keys(input).sort().join(",") === "run_nonce,token_id" && input.token_id === t, `${t}: the on-chain input is only token_id and run_nonce`);
    ok(JSON.parse(req.source).Project.version_key === PIN, `${t}: the request pins the engine build ${PIN.slice(0, 12)}...`);
    ok(result.ok && result.value === "stored:1", `${t}: callback stored the receipt (${result.value || result.failure})`);
    const r = await view("receipts", "get_latest", { token_id: t });
    ok(r && r.score === score && r.band === band && r.version_key === PIN && r.seq === 1, `${t}: stored score ${r && r.score} ${r && r.band}, seq 1, pinned build`);
    ok(r && r.receipt_sha256 === createHash("sha256").update(r.receipt).digest("hex"), `${t}: receipt_sha256 is the sha256 of the stored bytes`);
    const after = BigInt((await provider.viewAccount({ accountId: id("runner"), blockQuery: { finality: "final" } })).amount);
    const paid = before - after;
    const storageCost = BigInt(r.receipt.length) * 10n ** 19n; // at least the receipt bytes, at 1e19 yocto per byte
    ok(paid > nearToYocto("0.01") + storageCost && paid < nearToYocto("0.12"), `${t}: runner paid ${Number(paid) / 1e24} NEAR: the OutLayer deposit plus the receipt's storage, the rest refunded`);
  }
  ok((await view("receipts", "get_latest", { token_id: "DEMO-CREDIT" })).caps.includes("collection_shortfall"), "DEMO-CREDIT carries collection_shortfall on chain");

  // ---- failures ----------------------------------------------------------------------------------------------
  const noDues = structuredClone(datasets["DEMO-RENTAL"]);
  delete noDues.manager_export.charges;
  let f = await run("DEMO-RENTAL", { ds: noDues });
  ok(f.result.value === "module_failed:dues_missing", `module error stores only its code (${f.result.value})`);
  // an admitted run that fails: OutLayer resolves null and refunds the payer (the runner) itself; the receipt contract
  // refunds only the unused storage deposit. Refused at admission: NEAR returns the deposit to the receipt contract,
  // which passes it on. Either way the runner ends up paying less than the OutLayer deposit, and more than nothing
  // (gas and the stored failure code), so no deposit is lost and none is refunded twice.
  const runnerBalance = async () => BigInt((await provider.viewAccount({ accountId: id("runner"), blockQuery: { finality: "final" } })).amount);
  let b0 = await runnerBalance();
  f = await run("DEMO-RENTAL", { fail: true });
  let paid = b0 - (await runnerBalance());
  ok(f.result.value === "outlayer_run_failed", `an admitted run that failed stores outlayer_run_failed (${f.result.value})`);
  ok(paid > 0n && paid < nearToYocto("0.01"), `after an admitted failure the runner paid ${Number(paid) / 1e24} NEAR: gas and storage only, deposit refunded once`);
  ok((await call("worker", "outlayer", "set_refuse", { refuse: true })).ok, "mock OutLayer refuses requests at admission");
  b0 = await runnerBalance();
  f = await run("DEMO-RENTAL", { refused: true });
  paid = b0 - (await runnerBalance());
  ok(f.result.value === "outlayer_admission_failed", `a request refused at admission stores outlayer_admission_failed (${f.result.value})`);
  ok(paid > 0n && paid < nearToYocto("0.01"), `after an admission failure the runner paid ${Number(paid) / 1e24} NEAR: the deposit came back through the receipt contract`);
  ok((await view("receipts", "get_token", { token_id: "DEMO-RENTAL" })).pending === null, "nothing left pending after the admission failure");
  ok((await call("worker", "outlayer", "set_refuse", { refuse: false })).ok, "mock OutLayer admits again");
  f = await run("DEMO-RENTAL", { tamper: (o) => JSON.stringify({ ...JSON.parse(o), tenants: ["Tenant DEMO-RENTAL 01"] }) });
  ok(f.result.value === "receipt_rejected:top_fields", `a receipt with a private field is rejected with a fixed code (${f.result.value})`);
  f = await run("DEMO-RENTAL", { tamper: (o) => JSON.stringify(o) });
  ok(f.result.value === "receipt_not_object", `a receipt delivered as a JSON string is refused (${f.result.value})`);
  const strOcc = structuredClone(datasets["DEMO-RENTAL"]);
  strOcc.issuer.occupancy_bps = "SENTINEL-not-a-number";
  f = await run("DEMO-RENTAL", { ds: strOcc });
  ok(f.result.value === "module_failed:occupancy_bps_invalid", `a string occupancy_bps fails closed in the engine (${f.result.value})`);
  for (const bad of ["N/A", 9583.5, "9583"]) {
    f = await run("DEMO-RENTAL", { tamper: (o) => { const v = JSON.parse(o); v.metrics.occupancy_bps = bad; return JSON.stringify(v); } });
    ok(f.result.value === "receipt_rejected:metrics_value", `the callback rejects a non-integer metric occupancy_bps=${JSON.stringify(bad)} (${f.result.value})`);
  }
  f = await run("DEMO-RENTAL", { tamper: (o) => JSON.stringify({ ...JSON.parse(o), run_nonce: "ab".repeat(32) }) });
  ok(f.result.value === "receipt_rejected:run_nonce", `a receipt for another request is rejected (${f.result.value})`);
  ok((await view("receipts", "get_latest", { token_id: "DEMO-RENTAL" })).seq === 1, "DEMO-RENTAL still has only its one good receipt");
  const latest = await view("receipts", "get_latest", { token_id: "DEMO-RENTAL" });
  ok(!latest.receipt.includes("Tenant"), "no tenant name in the stored receipt");
  f = await run("DEMO-RENTAL");
  ok(f.result.value === "stored:2", `a later good run is seq 2 (${f.result.value})`);
  // the input of that run was built by the contract from seq 1: previous passport and period, no as_of, no new_period
  const in2 = JSON.parse(f.req.input_data);
  const seq1 = JSON.parse((await view("receipts", "get_receipt", { token_id: "DEMO-RENTAL", seq: 1 })).receipt);
  ok(Object.keys(in2).sort().join(",") === "previous,previous_period,run_nonce,token_id", `the second run's input is token_id, run_nonce, previous, previous_period (${Object.keys(in2).sort().join(",")})`);
  ok(in2.previous_period === seq1.period && in2.previous.every((p, i) => p.snapshot_sha256 === seq1.passport[i].snapshot_sha256 && p.as_of === seq1.passport[i].as_of), "previous and previous_period are seq 1's passport and period");
  const seq2 = JSON.parse((await view("receipts", "get_latest", { token_id: "DEMO-RENTAL" })).receipt);
  ok(seq2.passport.every((p) => p.carried_forward === false) && seq2.score === seq1.score, "same period, so nothing is carried forward and the score is unchanged");

  // severe arrears: HONEST-RENTAL with every rent payment removed; rental late_share_bps is arrears over one period's
  // rent, so 4 months unpaid is 40000 and must be stored (red), not rejected, or the old green receipt would stand
  f = await run("HONEST-RENTAL", { ds: severeArrears(datasets["HONEST-RENTAL"]) });
  ok(f.result.value === "stored:2", `HONEST-RENTAL in severe arrears is stored as seq 2 (${f.result.value})`);
  const sev = await view("receipts", "get_latest", { token_id: "HONEST-RENTAL" });
  const sevR = JSON.parse(sev.receipt);
  ok(sev.seq === 2 && sev.score === 59 && sev.band === "red" && sevR.metrics.late_share_bps === 40000, `the latest HONEST-RENTAL receipt is now ${sev.score} ${sev.band}, late_share_bps ${sevR.metrics.late_share_bps}`);
  ok(sev.caps.join(",") === "payout_exceeds_net_cash,collection_shortfall", `with caps ${sev.caps.join(", ")}`);

  // ---- query contract and API --------------------------------------------------------------------------------
  const wrong = await call("agent", "query", "buy_query", { request_id: "e2e-report-0001", query_hash: queryHash("report", "DEMO-CREDIT"), kind: "report" }, { deposit: nearToYocto("0.02") });
  ok(!wrong.ok, "buy_query with the wrong amount is refused");
  ok((await view("query", "get_entitlement", { request_id: "e2e-report-0001" })) === null, "nothing stored for the refused purchase");
  ok((await call("agent", "query", "buy_query", { request_id: "e2e-report-0001", query_hash: queryHash("report", "DEMO-CREDIT"), kind: "report" }, { deposit: nearToYocto("0.01") })).ok, "agent buys a report entitlement for exactly 0.01 NEAR");
  ok((await call("agent", "query", "buy_query", { request_id: "e2e-ask-00001", query_hash: queryHash("ask", "DEMO-CREDIT"), kind: "ask" }, { deposit: nearToYocto("0.01") })).ok, "agent buys an ask entitlement");

  const chain = nearChain({ rpcUrl: sandbox.rpcUrl, query: id("query"), redeemerId: id("api"), keyFile: join(keys, `${id("api")}.json`) });
  server = createServer({ chain, receipts: id("receipts"), query: id("query"), fee: nearToYocto("0.01").toString() });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p, e) => fetch(base + p, { headers: e ? { "x-truenav-entitlement": e } : {} });
  const s1 = await (await get("/fund/DEMO-CREDIT/score")).json();
  ok(s1.score === 58 && s1.band === "red" && s1.collection.rate_bps === 7857, "API /score (free) matches the chain");
  ok((await get("/fund/DEMO-CREDIT/report")).status === 402, "API /report without an entitlement is 402");
  const rep = await get("/fund/DEMO-CREDIT/report", "e2e-report-0001");
  const repBody = await rep.json();
  ok(rep.status === 200 && repBody.receipt.token_id === "DEMO-CREDIT" && repBody.entitlement.uses_left === 0, "API /report spends the entitlement on chain and returns the receipt");
  ok((await view("query", "get_entitlement", { request_id: "e2e-report-0001" })).uses_left === 0, "the use is recorded on chain");
  ok((await get("/fund/DEMO-CREDIT/report", "e2e-report-0001")).status === 402, "a second /report with the same entitlement is 402");
  const askR = await fetch(base + "/ask", { method: "POST", headers: { "content-type": "application/json", "x-truenav-entitlement": "e2e-ask-00001" }, body: JSON.stringify({ token_id: "DEMO-CREDIT", question: "collection rate?" }) });
  ok(askR.status === 501 && (await view("query", "get_entitlement", { request_id: "e2e-ask-00001" })).uses_left === 20, "API /ask checks the entitlement, spends nothing, 501 until step 6");
  const s2 = await (await get("/fund/DEMO-CREDIT/score")).json();
  ok(JSON.stringify(s2) === JSON.stringify(s1), "the purchases did not change the score response");
  const redeemByAgent = await call("agent", "query", "redeem", { request_id: "e2e-ask-00001", query_hash: queryHash("ask", "DEMO-CREDIT") });
  ok(!redeemByAgent.ok, "only the API account can redeem");

  // ---- the demo agent (agent/): free score, one paid report entitlement, a decision with the receipt reference ----
  // its own account and key file; the clock is the synthetic data's run day, like the engine's, so the rule's
  // 45-day freshness check does not depend on when this test runs
  const agentC = agentChain({ rpcUrl: sandbox.rpcUrl, query: id("query"), accountId: id("agent"), keyFile: join(keys, `${id("agent")}.json`) });
  const agentRun = (token) => runAgent({ chain: agentC, token, receipts: id("receipts"), query: id("query"), requestId: newRequestId(token, createHash("sha256").update(`e2e-${token}`).digest("hex").slice(0, 12)), execute: true, apiUrl: base, nowMs: Date.parse(RUN_AS_OF) + 3_600_000 });
  const agentBalance = async () => BigInt((await provider.viewAccount({ accountId: id("agent"), blockQuery: { finality: "final" } })).amount);
  for (const [t, action, why] of [["DEMO-CREDIT", "decline", "red"], ["HONEST-CREDIT", "approve", "green"], ["HONEST-RENTAL", "decline", "red"]]) {
    const b0 = await agentBalance();
    const out = await agentRun(t);
    const spent = b0 - (await agentBalance());
    const live = await view("receipts", "get_latest", { token_id: t });
    console.log(`  agent: ${summary(out)}`);
    ok(out.decision.action === action && out.decision.reason === why, `agent ${t}: ${out.decision.action} (${out.decision.detail})`);
    ok(out.receipt.seq === live.seq && out.receipt.receipt_sha256 === live.receipt_sha256, `agent ${t}: decision cites the stored receipt, seq ${live.seq}`);
    const ent = await view("query", "get_entitlement", { request_id: out.entitlement.request_id });
    ok(ent && ent.buyer === id("agent") && ent.query_hash === agentQueryHash("report", t) && ent.paid === nearToYocto("0.01").toString() && ent.uses_left === 0 && out.report.receipt_sha256 === live.receipt_sha256, `agent ${t}: bought one report entitlement for 0.01 NEAR and spent it on the API report of that receipt`);
    ok(spent >= nearToYocto("0.01") && spent < nearToYocto("0.012"), `agent ${t}: spent ${(Number(spent) / 1e24).toFixed(5)} NEAR (the fee plus gas)`);
  }
  const b1 = await agentBalance();
  const none = await agentRun("NO-SUCH-TOKEN");
  ok(none.decision.reason === "no_receipt" && !none.entitlement.bought && (await agentBalance()) === b1, "agent: a token with no receipt is declined and nothing is bought");
} catch (e) {
  console.log(`FAIL ${e.stack || e}`);
  failures++;
} finally {
  if (server) server.close();
  rmSync(keys, { recursive: true, force: true });
  await sandbox.tearDown();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
