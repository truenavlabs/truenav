// Step 4 end to end on a local NEAR sandbox node (no testnet, no OutLayer, no network after the sandbox binary is
// downloaded): the receipt contract, the query contract and a mock OutLayer (receipts/mock-outlayer, yield and
// resume like request_execution) are deployed; for each synthetic fund a runner calls request_run, the harness acts
// as the OutLayer worker by running the real engine natively (outlayer/engine-v2 examples/native.rs, the same
// tee::execute as the wasm) on the request's public input, and resolves the yield. Then the API is started against
// the sandbox and an agent buys and spends entitlements.
//
//   npm run e2e:receipts   (builds the three contract wasms and the native engine first if missing)
// The receipt wasm is receipts/target/near-sandbox, built with --features sandbox.
// A testnet build stays in target/near and must not contain outlayer.test.near.
//
// The sandbox root account uses the development key published in the near-sandbox package; it controls only this
// throwaway local chain. Sub-account keys live in a temporary keychain that is deleted afterwards.
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { Sandbox, GenesisAccount, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from "near-sandbox";
import { Account, JsonRpcProvider, KeyPair, actions, baseEncode, nearToYocto, teraToGas } from "near-api-js";
import { createServer, queryHash, spendMessage } from "../../api/server.mjs";
import { initSpendStore } from "../../api/spend-store.mjs";
import { nearChain } from "../../api/chain.mjs";
import { RUN_AS_OF, BANK_FETCHED_AT } from "../../cashflow/demo/data.mjs";
import { severeArrears } from "../tests/arrears.mjs";
import { runAgent, summary, newRequestId, queryHash as agentQueryHash } from "../../agent/agent.mjs";
import { agentChain } from "../../agent/chain.mjs";
import { ensureContractWasm } from "./ensure-wasm.mjs";
import { exampleEnvelope, guestFromEngine, V3_PIN } from "./public-v3.mjs";

const root = new URL("../../", import.meta.url).pathname;
const wasm = {
  receipts: ensureContractWasm({ crate: "receipts", artifact: "truenav_receipts", sandbox: true }),
  query: ensureContractWasm({ crate: "query", artifact: "truenav_query" }),
  outlayer: ensureContractWasm({ crate: "receipts/mock-outlayer", artifact: "mock_outlayer" }),
};
const engine = join(root, "outlayer/engine-v2/target/debug/examples/native");
if (!existsSync(engine)) execSync("cargo build --locked --example native", { cwd: join(root, "outlayer/engine-v2"), stdio: "inherit" });
const PIN = V3_PIN;
const example = exampleEnvelope();

let failures = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${what}`);
  if (!cond) failures++;
};

const receiptsGenesis = GenesisAccount.createDefault("receipts.tnlab-718ca9.testnet");
const sandbox = await Sandbox.start({ config: { additionalAccounts: [GenesisAccount.createDefault("outlayer.test.near"), receiptsGenesis] } });
const keys = mkdtempSync(join(tmpdir(), "truenav-receipts-keys-"));
let server;
try {
  const provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
  const rootAcc = new Account(DEFAULT_ACCOUNT_ID, provider, DEFAULT_PRIVATE_KEY);
  const id = (n) => (n === "outlayer" ? "outlayer.test.near" : n === "receipts" ? "receipts.tnlab-718ca9.testnet" : `${n}.${DEFAULT_ACCOUNT_ID}`);
  const accounts = {};
  accounts.outlayer = new Account("outlayer.test.near", provider, DEFAULT_PRIVATE_KEY);
  accounts.receipts = new Account("receipts.tnlab-718ca9.testnet", provider, receiptsGenesis.privateKey);
  for (const [n, near] of [["admin", "20"], ["pauser", "5"], ["runner", "20"], ["worker", "5"], ["api", "5"], ["agent", "5"], ["query", "10"]]) {
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
    outlayer: id("outlayer"), project_id: `${id("receipts")}/truenav-engine`, version_key: PIN, method: "truenav-v3.0.1", secrets_profile: "engine", secrets_owner: id("receipts"),
    max_instructions: 10_000_000_000, max_memory_mb: 128, max_execution_seconds: 30,
    outlayer_deposit: nearToYocto("0.01").toString(), storage_deposit: nearToYocto("0.30").toString(), outlayer_tgas: 230, callback_tgas: 50,
  };
  ok((await deploy("outlayer", wasm.outlayer, "new", { worker: id("worker") })).ok, "mock OutLayer deployed");
  ok((await deploy("receipts", wasm.receipts, "new", { admin: id("admin"), pauser: id("pauser"), config })).ok, "receipt contract deployed");
  ok((await deploy("query", wasm.query, "new", { admin: id("admin"), redeemer: id("api"), fee: nearToYocto("0.01").toString() })).ok, "query contract deployed");
  ok((await call("admin", "receipts", "set_runner", { account: id("runner"), allowed: true }, { deposit: 1n })).ok, "runner set (admin, 1 yocto)");
  const funds = { "DEMO-CREDIT": "credit", "DEMO-RENTAL": "credit", "HONEST-CREDIT": "credit", "HONEST-RENTAL": "credit" };
  for (const [t, k] of Object.entries(funds)) await call("admin", "receipts", "register_token", { token_id: t, kind: k }, { deposit: 1n });
  ok((await call("admin", "receipts", "pause", {}, { deposit: 1n })).ok, "paused for v3 migration");
  ok((await call("receipts", "receipts", "migrate_v3", {})).ok, "migrated to v3");
  const fundContext = { fund_account: example.fund_account, period_start: example.period_start, period_end: example.period_end, judge_valuation_time: example.valuation_time, source_registry_sha256: "a".repeat(64), supersedes_seq: null, correction_reason_code: null };
  for (const t of Object.keys(funds)) ok((await call("admin", "receipts", "configure_v3_fund", { token_id: t, context: fundContext }, { deposit: 1n })).ok, `${t} v3 fund configured`);
  ok((await call("admin", "receipts", "unpause", {}, { deposit: 1n })).ok, "unpaused after v3 configuration");
  const correct = async (token, seq) => {
    const paused = await call("admin", "receipts", "pause", {}, { deposit: 1n });
    const configured = await call("admin", "receipts", "configure_v3_fund", { token_id: token, context: { ...fundContext, supersedes_seq: String(seq), correction_reason_code: "coverage_correction" } }, { deposit: 1n });
    const resumed = await call("admin", "receipts", "unpause", {}, { deposit: 1n });
    if (!paused.ok || !configured.ok || !resumed.ok) throw new Error(`correct ${token} ${seq} ${paused.failure || ""} ${configured.failure || ""} ${resumed.failure || ""}`);
  };
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
      const open = (await view("outlayer", "get_requests")).filter((r) => { const v = JSON.parse(r.input_data); return (v.token_id || v.context?.token_id) === token; });
      if (open.length) {
        const r = open[0];
        const engineOut = fail ? "" : execFileSync(engine, [dsFile(token, ds), BANK_FETCHED_AT], { input: JSON.stringify({ token_id: token, run_nonce: JSON.parse(r.input_data).context?.request_nonce || "sandbox", as_of: RUN_AS_OF }) }).toString();
        let parsed = null;
        try { parsed = JSON.parse(engineOut); } catch { parsed = null; }
        let out = fail || (parsed && parsed.error) ? engineOut : guestFromEngine(example, engineOut, JSON.parse(r.input_data).context);
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
    const signed = await accounts.runner.createSignedTransaction({ receiverId: id("receipts"), actions: [actions.functionCall("request_run", { token_id: token }, teraToGas("300"), nearToYocto("0.32"))] });
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
    ok(input.receipt_version === "3" && input.context.token_id === t && typeof input.context.request_nonce === "string", `${t}: the on-chain input is the v3 context for ${t}`);
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
  ok(paid > 0n && paid < nearToYocto("0.02"), `after an admitted failure the runner paid ${Number(paid) / 1e24} NEAR: gas and the failure record, deposits refunded`);
  ok((await call("worker", "outlayer", "set_refuse", { refuse: true })).ok, "mock OutLayer refuses requests at admission");
  b0 = await runnerBalance();
  f = await run("DEMO-RENTAL", { refused: true });
  paid = b0 - (await runnerBalance());
  ok(f.result.value === "outlayer_admission_failed", `a request refused at admission stores outlayer_admission_failed (${f.result.value})`);
  ok(paid > 0n && paid < nearToYocto("0.02"), `after an admission failure the runner paid ${Number(paid) / 1e24} NEAR: the deposit came back through the receipt contract`);
  ok((await view("receipts", "get_token", { token_id: "DEMO-RENTAL" })).pending === null, "nothing left pending after the admission failure");
  ok((await call("worker", "outlayer", "set_refuse", { refuse: false })).ok, "mock OutLayer admits again");

  // the admin cleared a stuck request, and its OutLayer callback arrives later: a FAILED promise (OutLayer's own
  // callback failing after admission) refunds the OutLayer deposit once; a successful late result refunds none
  async function clearedThen(token, { panic, output }) {
    const signed = await accounts.runner.createSignedTransaction({ receiverId: id("receipts"), actions: [actions.functionCall("request_run", { token_id: token }, teraToGas("300"), nearToYocto("0.32"))] });
    const hash = baseEncode(createHash("sha256").update(signed.transaction.encode()).digest());
    const b0 = await runnerBalance();
    await provider.sendTransactionAsync(signed);
    let r;
    for (let i = 0; i < 60 && !r; i++) {
      r = (await view("outlayer", "get_requests")).find((x) => { const v = JSON.parse(x.input_data); return (v.token_id || v.context?.token_id) === token; });
      if (!r) await new Promise((res) => setTimeout(res, 500));
    }
    const cleared = await call("admin", "receipts", "clear_pending", { token_id: token }, { deposit: 1n });
    if (panic) await call("worker", "outlayer", "set_panic_on_resolve", { panic: true });
    const out = output ?? execFileSync(engine, [dsFile(token, datasets[token]), BANK_FETCHED_AT], { input: JSON.stringify({ ...JSON.parse(r.input_data), as_of: RUN_AS_OF }) }).toString();
    await call("worker", "outlayer", "resolve", { request_id: r.request_id, success: true, output: out });
    if (panic) await call("worker", "outlayer", "set_panic_on_resolve", { panic: false });
    let t;
    for (let i = 0; i < 60 && !t; i++) {
      try {
        t = await provider.viewTransactionStatusWithReceipts({ txHash: hash, accountId: id("runner"), waitUntil: "FINAL" });
      } catch {
        await new Promise((res) => setTimeout(res, 500));
      }
    }
    const lateLogs = t.receipts_outcome.flatMap((ro) => ro.outcome.logs).filter((l) => l.includes("late_callback"));
    // gas burnt by this contract's on_run_result receipt (the callback)
    const cb = t.receipts_outcome.filter((ro) => ro.outcome.executor_id === id("receipts")).at(-1);
    const fails = t.receipts_outcome.filter((ro) => ro.outcome.status.Failure).map((ro) => `${ro.outcome.executor_id}: ${JSON.stringify(ro.outcome.status.Failure).slice(0, 160)}`);
    return { cleared, result: status(t), paid: b0 - (await runnerBalance()), lateLogs, callbackGas: cb ? BigInt(cb.outcome.gas_burnt) : null, fails };
  }
  let lc = await clearedThen("DEMO-CREDIT", { panic: true });
  ok(lc.cleared.ok, "the admin cleared the stuck DEMO-CREDIT request (1 yocto)");
  ok(lc.result.ok && lc.result.value === "late_refunded", `a FAILED promise after clear_pending is refunded late (${lc.result.value || lc.result.failure})`);
  ok(lc.lateLogs.length === 1, `exactly one late_callback event (${lc.lateLogs.length})`);
  ok(lc.paid > 0n && lc.paid < nearToYocto("0.01"), `the runner got the OutLayer deposit back once: paid ${Number(lc.paid) / 1e24} NEAR in all (gas only, no double refund)`);
  ok((await view("receipts", "get_token", { token_id: "DEMO-CREDIT" })).pending === null && (await view("receipts", "get_latest", { token_id: "DEMO-CREDIT" })).seq === 1, "nothing pending, nothing stored, DEMO-CREDIT still on its seq 1");
  lc = await clearedThen("DEMO-CREDIT", { panic: false });
  ok(lc.result.ok && lc.result.value === "late_ignored", `a successful result after clear_pending is ignored (${lc.result.value || lc.result.failure})`);
  ok(lc.paid >= nearToYocto("0.01") && lc.paid < nearToYocto("0.012"), `and refunds no OutLayer deposit: paid ${Number(lc.paid) / 1e24} NEAR (the deposit OutLayer used, plus gas)`);
  ok((await view("receipts", "get_latest", { token_id: "DEMO-CREDIT" })).seq === 1, "the late receipt is not stored");
  // an oversized late success (2 MiB, 209 times the receipt limit; the mock OutLayer burns about 73 Tgas per MiB
  // to return it, so this is near the most it can send) at exactly the minimum callback gas: the late record is
  // cleared, held comes back, no OutLayer deposit is refunded, nothing is stored; and in flight it is refused as
  // too large. Callback gas below the minimum is refused.
  const config0 = (await view("receipts", "get_config")).config;
  ok(!(await call("admin", "receipts", "set_config", { config: { ...config0, callback_tgas: 39 } }, { deposit: 1n })).ok, "callback gas below the 40 Tgas minimum is refused");
  ok((await call("admin", "receipts", "set_config", { config: { ...config0, callback_tgas: 40 } }, { deposit: 1n })).ok, "callback gas set to the 40 Tgas minimum");
  const big = `BIG:${2 * 1024 * 1024}`;
  const storage0 = BigInt((await provider.viewAccount({ accountId: id("receipts"), blockQuery: { finality: "final" } })).storage_usage);
  lc = await clearedThen("DEMO-CREDIT", { panic: false, output: big });
  ok(lc.result.ok && lc.result.value === "late_ignored" && lc.lateLogs.length === 1 && lc.fails.length === 0, `a 2 MiB late success at 40 Tgas is handled (${lc.result.value || lc.result.failure}, failures ${lc.fails.length})`);
  ok(lc.callbackGas !== null && lc.callbackGas < 10n ** 13n, `its callback burnt ${Number(lc.callbackGas) / 1e12} Tgas of 40`);
  // the late_callback event names the refund: the held record bytes only (well under the 0.01 OutLayer deposit); the
  // runner also paid the gas of the mock sending 2 MiB, so its balance alone does not show it
  const lateEv = JSON.parse(lc.lateLogs[0].slice("EVENT_JSON:".length)).data[0];
  ok(lateEv.code === "late_ignored" && BigInt(lateEv.refund) > 0n && BigInt(lateEv.refund) < nearToYocto("0.002") && lc.paid >= nearToYocto("0.01"), `held came back (${Number(BigInt(lateEv.refund)) / 1e24} NEAR) and no OutLayer deposit was refunded (the runner paid ${Number(lc.paid) / 1e24} NEAR with the mock's gas)`);
  const storage1 = BigInt((await provider.viewAccount({ accountId: id("receipts"), blockQuery: { finality: "final" } })).storage_usage);
  ok(storage1 === storage0, `the late record is cleared: receipts storage back to ${storage1} bytes (was ${storage0})`);
  ok((await view("receipts", "get_latest", { token_id: "DEMO-CREDIT" })).seq === 1 && (await view("receipts", "get_token", { token_id: "DEMO-CREDIT" })).pending === null, "nothing stored, nothing pending");
  f = await run("DEMO-CREDIT", { tamper: () => big });
  ok(f.result.value === "receipt_too_large", `a 2 MiB result in flight at 40 Tgas is refused as too large (${f.result.value || f.result.failure})`);
  ok((await view("receipts", "get_token", { token_id: "DEMO-CREDIT" })).pending === null, "and nothing stays pending");
  ok((await call("admin", "receipts", "set_config", { config: config0 }, { deposit: 1n })).ok, "callback gas back to 50");
  f = await run("DEMO-RENTAL", { tamper: (o) => { const v = JSON.parse(o); v.private = { ...(v.private || {}), tenants: ["Tenant DEMO-RENTAL 01"] }; return JSON.stringify(v); } });
  ok(!(await view("receipts", "get_latest", { token_id: "DEMO-RENTAL" })).receipt.includes("Tenant"), `a private field is not stored (${f.result.value})`);
  f = await run("DEMO-RENTAL", { tamper: (o) => JSON.stringify(o) });
  ok(f.result.value === "v3_execution_shape" || f.result.value === "receipt_not_object", `a receipt delivered as a JSON string is refused (${f.result.value})`);
  const strOcc = structuredClone(datasets["DEMO-RENTAL"]);
  strOcc.issuer.occupancy_bps = "SENTINEL-not-a-number";
  f = await run("DEMO-RENTAL", { ds: strOcc });
  ok(f.result.value === "module_failed:occupancy_bps_invalid", `a string occupancy_bps fails closed in the engine (${f.result.value})`);
  for (const bad of ["N/A", 9583.5, "9583"]) {
    f = await run("DEMO-RENTAL", { tamper: (o) => { const v = JSON.parse(o); v.private = { ...(v.private || {}), metrics: { occupancy_bps: bad } }; return JSON.stringify(v); } });
    const latest = await view("receipts", "get_latest", { token_id: "DEMO-RENTAL" });
    ok(!latest.receipt.includes(String(bad)), `a non-integer metric stays off chain occupancy_bps=${JSON.stringify(bad)} (${f.result.value})`);
  }
  f = await run("DEMO-RENTAL", { tamper: (o) => { const v = JSON.parse(o); v.request_nonce = "ab".repeat(32); return JSON.stringify(v); } });
  ok(f.result.value === "v3_context_mismatch", `a receipt for another request is rejected (${f.result.value})`);
  ok((await view("receipts", "get_latest", { token_id: "DEMO-RENTAL" })).seq === 1, "DEMO-RENTAL still has only its one good receipt");
  const latest = await view("receipts", "get_latest", { token_id: "DEMO-RENTAL" });
  ok(!latest.receipt.includes("Tenant"), "no tenant name in the stored receipt");
  const seq1hash = (await view("receipts", "get_latest", { token_id: "DEMO-RENTAL" })).receipt_sha256;
  await correct("DEMO-RENTAL", 1);
  f = await run("DEMO-RENTAL");
  ok(f.result.value === "stored:2", `a later good run is seq 2 (${f.result.value})`);
  const in2 = JSON.parse(f.req.input_data);
  const seq1 = await view("receipts", "get_receipt", { token_id: "DEMO-RENTAL", seq: 1 });
  ok(in2.receipt_version === "3" && in2.context.prev_receipt_sha256 === seq1hash, `the second run carries seq 1 public hash (${in2.context && in2.context.prev_receipt_sha256})`);
  ok(seq1.score === 58, `seq 1 public score is ${seq1.score}`);
  const seq2 = JSON.parse((await view("receipts", "get_latest", { token_id: "DEMO-RENTAL" })).receipt);
  ok(seq2.score === seq1.score && !JSON.stringify(seq2).includes("outstanding_cents"), "same period, score unchanged, no private cents");

  // severe arrears: HONEST-RENTAL with every rent payment removed; rental late_share_bps is arrears over one period's
  // rent, so 4 months unpaid is 40000 and must be stored (red), not rejected, or the old green receipt would stand
  await correct("HONEST-RENTAL", 1);
  f = await run("HONEST-RENTAL", { ds: severeArrears(datasets["HONEST-RENTAL"]) });
  ok(f.result.value === "stored:2", `HONEST-RENTAL in severe arrears is stored as seq 2 (${f.result.value})`);
  const sev = await view("receipts", "get_latest", { token_id: "HONEST-RENTAL" });
  ok(sev.seq === 2 && sev.score === 59 && sev.band === "red" && !sev.receipt.includes("late_share_bps") && !sev.receipt.includes("payout_exceeds_net_cash"), `the latest HONEST-RENTAL receipt is now ${sev.score} ${sev.band} and private cap names are not stored`);
  ok(sev.caps.includes("collection_shortfall") && sev.receipt_sha256 === createHash("sha256").update(sev.receipt).digest("hex"), `public caps ${sev.caps.join(", ")} and the write-time hash matches`);

  // ---- query contract and API --------------------------------------------------------------------------------
  const wrong = await call("agent", "query", "buy_query", { request_id: "e2e-report-0001", query_hash: queryHash("report", "DEMO-CREDIT"), kind: "report" }, { deposit: nearToYocto("0.02") });
  ok(!wrong.ok, "buy_query with the wrong amount is refused");
  ok((await view("query", "get_entitlement", { request_id: "e2e-report-0001" })) === null, "nothing stored for the refused purchase");
  ok((await call("agent", "query", "buy_query", { request_id: "e2e-report-0001", query_hash: queryHash("report", "DEMO-CREDIT"), kind: "report" }, { deposit: nearToYocto("0.01") })).ok, "agent buys a report entitlement for exactly 0.01 NEAR");
  ok((await call("agent", "query", "buy_query", { request_id: "e2e-ask-00001", query_hash: queryHash("ask", "DEMO-CREDIT"), kind: "ask" }, { deposit: nearToYocto("0.01") })).ok, "agent buys an ask entitlement");

  const chain = nearChain({ rpcUrl: sandbox.rpcUrl, query: id("query"), redeemerId: id("api"), keyFile: join(keys, `${id("api")}.json`) });
  server = createServer({ chain, receipts: id("receipts"), query: id("query"), fee: nearToYocto("0.01").toString(), spendStore: await initSpendStore(join(keys, "spend-store"), { create: true }) });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const buyer = id("agent");
  const buyerKey = KeyPair.fromString(JSON.parse(readFileSync(join(keys, `${buyer}.json`), "utf8")).private_key);
  const buyerHeaders = (requestId, kind, token) => {
    const nonce = randomBytes(16).toString("hex");
    const exp = String(Date.now() + 60_000);
    const sig = Buffer.from(buyerKey.sign(spendMessage({ audience: id("query"), id: requestId, kind, token, nonce, exp })).signature).toString("base64");
    return { "x-truenav-entitlement": requestId, "x-truenav-buyer": buyer, "x-truenav-buyer-sig": sig, "x-truenav-buyer-nonce": nonce, "x-truenav-buyer-exp": exp };
  };
  const get = (p, e) => fetch(base + p, { headers: e ? buyerHeaders(e, p.endsWith("/report") ? "report" : "ask", decodeURIComponent(p.split("/")[2])) : {} });
  const honest = await view("receipts", "get_latest", { token_id: "HONEST-CREDIT" });
  const happy = await (await get("/fund/HONEST-CREDIT/score")).json();
  ok(happy.score === 100 && happy.band === "green" && happy.score === honest.score && happy.band === honest.band && happy.receipt_sha256 === honest.receipt_sha256 && happy.collection === undefined, `API /score (free) matches the chain (${JSON.stringify(happy)})`);
  const s1 = await (await get("/fund/DEMO-CREDIT/score")).json();
  ok(s1.score === 58 && s1.band === "red" && s1.receipt_sha256 === createHash("sha256").update((await view("receipts", "get_latest", { token_id: "DEMO-CREDIT" })).receipt).digest("hex") && !JSON.stringify(s1).includes("head_status"), `API /score returns the stored public receipt, not a view-time rewrite (${JSON.stringify(s1)})`);
  ok((await get("/fund/DEMO-CREDIT/report")).status === 402, "API /report without an entitlement is 402");
  const rep = await get("/fund/DEMO-CREDIT/report", "e2e-report-0001");
  const repBody = await rep.json();
  ok(rep.status === 200 && repBody.receipt.token_id === "DEMO-CREDIT" && repBody.entitlement.uses_left === 0, "API /report spends the entitlement on chain and returns the receipt");
  ok((await view("query", "get_entitlement", { request_id: "e2e-report-0001" })).uses_left === 0, "the use is recorded on chain");
  ok((await get("/fund/DEMO-CREDIT/report", "e2e-report-0001")).status === 402, "a second /report with the same entitlement is 402");
  const askR = await fetch(base + "/ask", { method: "POST", headers: { "content-type": "application/json", ...buyerHeaders("e2e-ask-00001", "ask", "DEMO-CREDIT") }, body: JSON.stringify({ token_id: "DEMO-CREDIT", question: "collection rate?" }) });
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
  for (const [t, action, why] of [["DEMO-CREDIT", "decline", "red"], ["HONEST-CREDIT", "review", "unattested"], ["HONEST-RENTAL", "decline", "red"]]) {
    const b0 = await agentBalance();
    const out = await agentRun(t);
    const spent = b0 - (await agentBalance());
    const live = await view("receipts", "get_latest", { token_id: t });
    console.log(`  agent: ${summary(out)}`);
    ok(out.decision.action === action && out.decision.reason === why, `agent ${t}: ${out.decision.action} (${out.decision.detail})`);
    ok(out.receipt && out.receipt.receipt_sha256 === live.receipt_sha256, `agent ${t}: cites the stored public hash`);
    if (!out.entitlement?.request_id) { ok(false, `agent ${t}: did not buy`); continue; }
    const ent = await view("query", "get_entitlement", { request_id: out.entitlement.request_id });
    ok(ent && ent.buyer === id("agent") && ent.query_hash === agentQueryHash("report", t) && ent.uses_left === 0, `agent ${t}: spent one report entitlement`);
    ok(spent >= nearToYocto("0.01") && spent < nearToYocto("0.012"), `agent ${t}: spent ${(Number(spent) / 1e24).toFixed(5)} NEAR`);
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
