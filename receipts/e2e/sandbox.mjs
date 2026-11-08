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

  const datasets = Object.fromEntries(Object.keys(funds).map((t) => [t, JSON.parse(readFileSync(join(root, `cashflow/fixtures/parity/cashflow-parity-${t}.json`))).input.dataset]));
  const dsFile = (t, ds) => {
    const f = join(keys, `ds-${t}-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(f, JSON.stringify(ds));
    return f;
  };
  // the worker: wait for the open request, run the engine on its public input, resolve the yield
  async function serve(token, { ds = datasets[token], tamper, fail } = {}) {
    for (let i = 0; i < 60; i++) {
      const open = (await view("outlayer", "get_requests")).filter((r) => JSON.parse(r.input_data).token_id === token);
      if (open.length) {
        const r = open[0];
        let out = fail ? "" : execFileSync(engine, [dsFile(token, ds), "2026-10-31T22:00:00Z"], { input: JSON.stringify({ ...JSON.parse(r.input_data), as_of: "2026-11-01T00:00:00Z" }) }).toString();
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
    const req = await serve(token, opts);
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
  const expect = { "DEMO-CREDIT": [58, "red"], "DEMO-RENTAL": [58, "red"], "HONEST-CREDIT": [97, "green"], "HONEST-RENTAL": [100, "green"] };
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
  f = await run("DEMO-RENTAL", { fail: true });
  ok(f.result.value === "outlayer_failed", `failed execution stores outlayer_failed (${f.result.value})`);
  f = await run("DEMO-RENTAL", { tamper: (o) => JSON.stringify({ ...JSON.parse(o), tenants: ["Tenant DEMO-RENTAL 01"] }) });
  ok(f.result.value === "receipt_rejected:top_unknown_field_tenants", `a receipt with a private field is rejected (${f.result.value})`);
  f = await run("DEMO-RENTAL", { tamper: (o) => JSON.stringify({ ...JSON.parse(o), run_nonce: "ab".repeat(32) }) });
  ok(f.result.value === "receipt_rejected:run_nonce", `a receipt for another request is rejected (${f.result.value})`);
  ok((await view("receipts", "get_latest", { token_id: "DEMO-RENTAL" })).seq === 1, "DEMO-RENTAL still has only its one good receipt");
  const latest = await view("receipts", "get_latest", { token_id: "DEMO-RENTAL" });
  ok(!latest.receipt.includes("Tenant"), "no tenant name in the stored receipt");
  f = await run("DEMO-RENTAL");
  ok(f.result.value === "stored:2", `a later good run is seq 2 (${f.result.value})`);

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
