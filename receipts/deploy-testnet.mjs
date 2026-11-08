// Step 4 testnet deploy, one step per run. Without --execute a step only PRINTS the exact transactions it would send
// (receiver, method, arguments, deposit, gas) and its cost; nothing is signed. With --execute it sends that step only,
// after its read-only checks pass. Testnet only (the RPC's chain id is checked). Keys: the master's key file in the
// legacy keychain (~/.near-credentials/testnet); new accounts get fresh keys written there with mode 600. No key is
// ever printed.
//
//   node receipts/deploy-testnet.mjs D0              read-only checks (no flag needed)
//   node receipts/deploy-testnet.mjs D1 [--execute]  create receipts, query, runner, api sub-accounts
//   node receipts/deploy-testnet.mjs D2 [--execute]  deploy + init the receipt contract (pinned engine build)
//   node receipts/deploy-testnet.mjs D3 [--execute]  register the 4 synthetic tokens, set the runner (1 yocto each)
//   node receipts/deploy-testnet.mjs D4 [--execute]  deploy + init the query contract (fee 0.01 NEAR, redeemer api)
//
// OutLayer (upload, project, secrets) and the first run are separate steps with their own yes (README.md).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Account, JsonRpcProvider, KeyPair, actions, nearToYocto, teraToGas } from "near-api-js";

const MASTER = process.env.TRUENAV_MASTER || "tnlab-718ca9.testnet";
const RPC = "https://rpc.testnet.near.org";
const KEYS = join(homedir(), ".near-credentials/testnet");
const root = new URL("../", import.meta.url).pathname;
const ids = { receipts: `receipts.${MASTER}`, query: `query.${MASTER}`, runner: `runner.${MASTER}`, api: `api.${MASTER}` };
// receipts and query hold their code storage (about 1 NEAR per 100 KB: 264,406 and 155,543 bytes; receipts measures
// 265,821 bytes after init and the 4 tokens on the sandbox, 2.66 NEAR of its 2.8, checked by the e2e); a run's receipt
// storage is paid by the runner's deposit; the runner needs one run's deposit (0.26 NEAR, mostly refunded)
const FUND = { receipts: "2.8", query: "1.7", runner: "0.4", api: "0.1" };
const NEED = Object.values(FUND).reduce((a, b) => a + nearToYocto(b), 0n) + nearToYocto("0.05");
const ENGINE_PIN = readFileSync(join(root, "outlayer/engine-v2/BUILD.md"), "utf8").match(/^\| wasm sha256 \| `([0-9a-f]{64})`/m)[1];
const WASM = { receipts: join(root, "receipts/target/near/truenav_receipts.wasm"), query: join(root, "query/target/near/truenav_query.wasm") };
const PINNED = JSON.parse(readFileSync(join(root, "receipts/pinned-builds.json"), "utf8"));
const TOKENS = { "DEMO-CREDIT": "credit", "DEMO-RENTAL": "rental", "HONEST-CREDIT": "credit", "HONEST-RENTAL": "rental" };
const CONFIG = {
  outlayer: "outlayer.testnet", project_id: `${ids.receipts}/truenav-engine`, version_key: ENGINE_PIN, method: "cashflow-v2.1.0", secrets_profile: "engine", secrets_owner: ids.receipts,
  max_instructions: 10_000_000_000, max_memory_mb: 128, max_execution_seconds: 30,
  outlayer_deposit: nearToYocto("0.01").toString(), storage_deposit: nearToYocto("0.25").toString(), outlayer_tgas: 230, callback_tgas: 50,
};

const step = process.argv[2];
const execute = process.argv.includes("--execute");
const provider = new JsonRpcProvider({ url: RPC });
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
const keyOf = (id) => JSON.parse(readFileSync(join(KEYS, `${id}.json`), "utf8")).private_key;
const exists = async (id) => provider.viewAccount({ accountId: id, blockQuery: { finality: "final" } }).then(() => true, () => false);
const show = (receiver, list) => {
  console.log(`  tx to ${receiver}:`);
  for (const a of list) console.log(`    ${a}`);
};
async function send(signerId, receiverId, acts) {
  const acc = new Account(signerId, provider, keyOf(signerId));
  const tx = await acc.signAndSendTransaction({ receiverId, actions: acts, throwOnFailure: false, waitUntil: "FINAL" });
  const hash = tx.transaction_outcome.id;
  const ok = tx.status && tx.status.SuccessValue !== undefined;
  console.log(`  ${ok ? "ok" : "FAILED"} https://testnet.nearblocks.io/txns/${hash}`);
  if (!ok) {
    console.log(`  ${JSON.stringify(tx.status).slice(0, 300)}`);
    process.exit(1);
  }
}

async function checks() {
  const status = await provider.viewNodeStatus();
  if (status.chain_id !== "testnet") throw new Error(`RPC chain_id is ${status.chain_id}, not testnet`);
  if (!existsSync(join(KEYS, `${MASTER}.json`))) throw new Error(`no key file for ${MASTER}`);
  const bal = BigInt((await provider.viewAccount({ accountId: MASTER, blockQuery: { finality: "final" } })).amount);
  console.log(`  chain testnet; ${MASTER} balance ${(Number(bal) / 1e24).toFixed(4)} NEAR; D1 needs ${(Number(NEED) / 1e24).toFixed(2)} NEAR with gas${bal < NEED ? `: SHORT by ${(Number(NEED - bal) / 1e24).toFixed(4)} NEAR` : ""}`);
  for (const [k, f] of Object.entries(WASM)) {
    if (!existsSync(f)) throw new Error(`${f} missing: build it in the pinned image (receipts/README.md)`);
    if (sha(f) !== PINNED[k]) throw new Error(`${k} wasm ${sha(f).slice(0, 12)} is not the pinned build ${PINNED[k].slice(0, 12)}`);
    console.log(`  ${k} wasm is the pinned build ${PINNED[k]}`);
  }
  console.log(`  engine build pinned in the receipt config: ${ENGINE_PIN}`);
  for (const id of Object.values(ids)) console.log(`  ${id}: ${(await exists(id)) ? "exists" : "free"}`);
  return bal;
}

const one = 1n;
console.log(`TrueNav step 4 deploy, ${step || "(no step)"}${execute ? " EXECUTE" : " (print only)"}, master ${MASTER}`);
if (!["D0", "D1", "D2", "D3", "D4"].includes(step)) {
  console.log("usage: node receipts/deploy-testnet.mjs D0|D1|D2|D3|D4 [--execute]");
  process.exit(2);
}
await checks();
if (step === "D1") {
  console.log(`D1: create 4 sub-accounts of ${MASTER}, each with a fresh full-access key (key files mode 600, never printed). Cost: ${Object.values(FUND).reduce((a, b) => a + Number(b), 0).toFixed(1)} NEAR moved to our own new accounts, plus gas (about 0.001 NEAR each).`);
  for (const [k, id] of Object.entries(ids)) show(id, [`CreateAccount`, `Transfer ${FUND[k]} NEAR`, `AddKey <new ed25519 key>, FullAccess`]);
  if (execute) {
    for (const [k, id] of Object.entries(ids)) {
      if (await exists(id)) throw new Error(`${id} already exists`);
      if (BigInt((await provider.viewAccount({ accountId: MASTER, blockQuery: { finality: "final" } })).amount) < NEED) throw new Error("master balance too low for D1");
      const kp = KeyPair.fromRandom("ed25519");
      writeFileSync(join(KEYS, `${id}.json`), JSON.stringify({ account_id: id, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
      await send(MASTER, id, [actions.createAccount(), actions.transfer(nearToYocto(FUND[k])), actions.addFullAccessKey(kp.getPublicKey())]);
    }
  }
}
if (step === "D2") {
  const args = { admin: MASTER, pauser: MASTER, config: CONFIG };
  console.log(`D2: deploy the receipt contract (wasm ${PINNED.receipts}, ${readFileSync(WASM.receipts).length} bytes) to ${ids.receipts} and initialise it. Cost: about 2.66 NEAR locked for code and state storage on ${ids.receipts} (265,821 bytes after D3, measured on the sandbox; its own balance, funded 2.8 in D1, about 0.14 left for gas), plus gas.`);
  show(ids.receipts, [`DeployContract sha256 ${PINNED.receipts}`, `FunctionCall new ${JSON.stringify(args)} gas 50 Tgas deposit 0`]);
  if (execute) await send(ids.receipts, ids.receipts, [actions.deployContract(new Uint8Array(readFileSync(WASM.receipts))), actions.functionCall("new", args, teraToGas("50"), 0n)]);
}
if (step === "D3") {
  console.log(`D3: register the 4 synthetic tokens and allow ${ids.runner} to request runs (admin calls, 1 yoctoNEAR each). Cost: gas plus about 0.002 NEAR storage on ${ids.receipts}.`);
  const calls = [...Object.entries(TOKENS).map(([t, k]) => ["register_token", { token_id: t, kind: k }]), ["set_runner", { account: ids.runner, allowed: true }]];
  show(ids.receipts, calls.map(([m, a]) => `FunctionCall ${m} ${JSON.stringify(a)} gas 30 Tgas deposit 1 yocto (signed by ${MASTER})`));
  if (execute) await send(MASTER, ids.receipts, calls.map(([m, a]) => actions.functionCall(m, a, teraToGas("30"), one)));
}
if (step === "D4") {
  const args = { admin: MASTER, redeemer: ids.api, fee: nearToYocto("0.01").toString() };
  console.log(`D4: deploy the query contract (wasm ${PINNED.query}, ${readFileSync(WASM.query).length} bytes) to ${ids.query} and initialise it. Cost: about 1.6 NEAR locked for code storage on ${ids.query}, plus gas.`);
  show(ids.query, [`DeployContract sha256 ${PINNED.query}`, `FunctionCall new ${JSON.stringify(args)} gas 50 Tgas deposit 0`]);
  if (execute) await send(ids.query, ids.query, [actions.deployContract(new Uint8Array(readFileSync(WASM.query))), actions.functionCall("new", args, teraToGas("50"), 0n)]);
}
if (!execute && step !== "D0") console.log("print only: nothing was sent. Re-run with --execute after the owner's yes.");
