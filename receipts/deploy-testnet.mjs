// Step 4 testnet deploy, one step per run. Without --execute a step only PRINTS the exact transactions it would send
// (receiver, method, arguments, deposit, gas) and its cost; nothing is signed. With --execute it sends that step only,
// after its read-only checks pass. Testnet only (the RPC's chain id is checked). Keys: the master's key file
// (TRUENAV_SIGNER_KEYFILE, default ~/.near-credentials/testnet/<master>.json; only its private_key is used and its
// public key must be a full-access key of the master on chain); new accounts get fresh keys written to
// ~/.near-credentials/testnet with mode 600, created exclusively (an existing file is never overwritten). No key is
// ever printed. Wasm: target/near of each crate, or TRUENAV_WASM_DIR (a directory holding truenav_receipts.wasm and
// truenav_query.wasm, e.g. unpacked from the receipts-pinned-build artifact); either way the bytes must match
// receipts/pinned-builds.json. The committed receipts/dist is stale and refused.
//
// The master account has no default: --master <fresh-account.testnet> or env TRUENAV_MASTER (receipts/deploy-args.mjs).
// A master that hosted an earlier deploy is refused with --execute.
//
//   node receipts/deploy-testnet.mjs D0 --master M              read-only checks (no flag needed)
//   node receipts/deploy-testnet.mjs D1 --master M [--execute]  create receipts, query, runner, api sub-accounts (resumable: an
//                                                    existing one is skipped only if its local key is a full-access
//                                                    key on chain, otherwise D1 stops)
//   node receipts/deploy-testnet.mjs D2 --master M [--execute]  deploy + init the receipt contract (pinned engine build)
//   node receipts/deploy-testnet.mjs D3 --master M [--execute]  register the 4 synthetic tokens, set the runner (1 yocto each)
//   node receipts/deploy-testnet.mjs D4 --master M [--execute]  deploy + init the query contract (fee 0.01 NEAR, redeemer api)
//
// OutLayer (upload, project, secrets) and the first run are separate steps with their own yes (README.md).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Account, JsonRpcProvider, KeyPair, actions, nearToYocto, teraToGas } from "near-api-js";
import { parseDeployArgs, UsageError, USAGE } from "./deploy-args.mjs";

// before anything else touches a file, a key or the network
let parsed;
try {
  parsed = parseDeployArgs(process.argv.slice(2));
} catch (e) {
  if (!(e instanceof UsageError)) throw e;
  console.error(`${e.message}\n${USAGE}`);
  process.exit(2);
}
const MASTER = parsed.master;
const RPC = parsed.rpc;
const KEYS = join(homedir(), ".near-credentials/testnet");
const root = new URL("../", import.meta.url).pathname;
const SIGNER_KEYFILE = process.env.TRUENAV_SIGNER_KEYFILE || join(KEYS, `${MASTER}.json`);
const ids = { receipts: `receipts.${MASTER}`, query: `query.${MASTER}`, runner: `runner.${MASTER}`, api: `api.${MASTER}` };
// receipts and query hold their code storage (about 1 NEAR per 100 KB: about 540 KB for the v3.0.1 candidate and 155,543 bytes for query;
// the initial code/state plus 0.1 NEAR margin must fit the 6 testnet NEAR budget, checked by the e2e); a run's receipt
// storage is paid by the runner's deposit; the runner needs one run's deposit (0.26 NEAR, mostly refunded)
const FUND = { receipts: "6", query: "1.7", runner: "0.4", api: "0.1" };
const GAS_MARGIN = nearToYocto("0.05");
const FUND_TOTAL = Object.values(FUND).reduce((a, b) => a + Number(b), 0).toFixed(1);
const ENGINE_PIN = readFileSync(join(root, "outlayer/engine-v2/BUILD.md"), "utf8").match(/^\| wasm sha256 \| `([0-9a-f]{64})`/m)[1];
const WASM_DIR = process.env.TRUENAV_WASM_DIR ? (isAbsolute(process.env.TRUENAV_WASM_DIR) ? process.env.TRUENAV_WASM_DIR : join(process.cwd(), process.env.TRUENAV_WASM_DIR)) : null;
const WASM = WASM_DIR
  ? { receipts: join(WASM_DIR, "truenav_receipts.wasm"), query: join(WASM_DIR, "truenav_query.wasm") }
  : { receipts: join(root, "receipts/target/near/truenav_receipts.wasm"), query: join(root, "query/target/near/truenav_query.wasm") };
const PINNED = JSON.parse(readFileSync(parsed.pinsFile || join(root, "receipts/pinned-builds.json"), "utf8"));
const TOKENS = { "DEMO-CREDIT": "credit", "DEMO-RENTAL": "rental", "HONEST-CREDIT": "credit", "HONEST-RENTAL": "rental" };
// project_id must stay receipts/truenav-engine. The pledge module derives loan-terms-v2 in this same project
// with caller predecessor, so the receipts account is the account in both keys. Do not point this at another project.
const CONFIG = {
  outlayer: "outlayer.testnet", project_id: `${ids.receipts}/truenav-engine`, version_key: ENGINE_PIN, method: "cashflow-v2.1.0", secrets_profile: "engine", secrets_owner: ids.receipts,
  max_instructions: 10_000_000_000, max_memory_mb: 128, max_execution_seconds: 30,
  outlayer_deposit: nearToYocto("0.01").toString(), storage_deposit: nearToYocto("0.25").toString(), outlayer_tgas: 230, callback_tgas: 50,
};

const step = parsed.step;
const execute = parsed.execute;
const provider = new JsonRpcProvider({ url: RPC });
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
// only the private_key field is taken from a key file; it is never printed
const keyFileOf = (id) => (id === MASTER ? SIGNER_KEYFILE : join(KEYS, `${id}.json`));
const keyOf = (id) => {
  const f = JSON.parse(readFileSync(keyFileOf(id), "utf8"));
  if (id === MASTER && process.env.TRUENAV_SIGNER_KEYFILE && f.account_id !== MASTER) throw new Error(`TRUENAV_SIGNER_KEYFILE is not a key file for ${MASTER} (account_id must equal ${MASTER})`);
  if (f.account_id !== undefined && f.account_id !== id) throw new Error(`key file ${keyFileOf(id)} is for another account`);
  return f.private_key;
};
const publicOf = (id) => KeyPair.fromString(keyOf(id)).getPublicKey().toString();
// absent only when the RPC answers UNKNOWN_ACCOUNT for exactly this account; any other error (timeout, 5xx) throws
const exists = async (id) => {
  try {
    await provider.viewAccount({ accountId: id, blockQuery: { finality: "final" } });
    return true;
  } catch (e) {
    if (e && e.name === "AccountDoesNotExistError" && e.accountId === id) return false;
    throw e;
  }
};
const isFullAccessKey = async (id, publicKey) => {
  try {
    const k = await provider.viewAccessKey({ accountId: id, publicKey, blockQuery: { finality: "final" } });
    return k.permission === "FullAccess";
  } catch (e) {
    if (e && e.name === "AccessKeyDoesNotExistError") return false; // UNKNOWN_ACCESS_KEY; anything else throws
    throw e;
  }
};
const balanceOf = async (id) => BigInt((await provider.viewAccount({ accountId: id, blockQuery: { finality: "final" } })).amount);
// what D1 still has to move: funding for the accounts that do not exist yet, plus a gas margin
const remainingNeed = async () => {
  let need = 0n;
  for (const [k, id] of Object.entries(ids)) if (!(await exists(id))) need += nearToYocto(FUND[k]);
  return need === 0n ? 0n : need + GAS_MARGIN;
};
const near = (y) => (Number(y) / 1e24).toFixed(4);
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
  if (!existsSync(SIGNER_KEYFILE)) throw new Error(`no key file for ${MASTER} at ${SIGNER_KEYFILE}`);
  const signerPub = publicOf(MASTER);
  if (!(await isFullAccessKey(MASTER, signerPub))) throw new Error(`signer key ${signerPub} is not a full-access key of ${MASTER}`);
  console.log(`  signer key file ${SIGNER_KEYFILE}: public key ${signerPub}, a full-access key of ${MASTER}`);
  const bal = await balanceOf(MASTER);
  const need = await remainingNeed();
  console.log(`  chain testnet; ${MASTER} balance ${near(bal)} NEAR; D1 still needs ${near(need)} NEAR (funding for the accounts not created yet, plus ${near(GAS_MARGIN)} gas margin; all four: ${FUND_TOTAL} + 0.05)${bal < need ? `: SHORT by ${near(need - bal)} NEAR` : ""}`);
  for (const [k, f] of Object.entries(WASM)) {
    if (!existsSync(f)) throw new Error(`${f} missing: build it in the pinned image (receipts/README.md) or set TRUENAV_WASM_DIR to a directory holding the two pinned files`);
    if (sha(f) !== PINNED[k]) throw new Error(`${k} wasm ${sha(f).slice(0, 12)} is not the pinned build ${PINNED[k].slice(0, 12)}`);
    console.log(`  ${k} wasm ${f.replace(root, "")} is the pinned build ${PINNED[k]}`);
  }
  console.log(`  engine build pinned in the receipt config: ${ENGINE_PIN}`);
  for (const id of Object.values(ids)) console.log(`  ${id}: ${(await exists(id)) ? "exists" : "free"}`);
  return bal;
}

const one = 1n;
console.log(`TrueNav step 4 deploy, ${step || "(no step)"}${execute ? " EXECUTE" : " (print only)"}, master ${MASTER}`);
await checks();
if (step === "D1") {
  console.log(`D1: create 4 sub-accounts of ${MASTER}, each with a fresh full-access key (key files mode 600, created exclusively, never printed). Cost: ${FUND_TOTAL} NEAR moved to our own new accounts (receipts ${FUND.receipts}, query ${FUND.query}, runner ${FUND.runner}, api ${FUND.api}), plus gas (about 0.001 NEAR each); the preflight needs ${FUND_TOTAL} + 0.05.`);
  // resumable: an account that exists is skipped only if its local key is a full-access key on chain
  const plan = [];
  for (const [k, id] of Object.entries(ids)) {
    if (await exists(id)) {
      if (!existsSync(keyFileOf(id))) throw new Error(`${id} exists but there is no local key file ${keyFileOf(id)}: stopping`);
      if (!(await isFullAccessKey(id, publicOf(id)))) throw new Error(`${id} exists but its local key is not a full-access key on chain: stopping`);
      console.log(`  ${id}: exists, local key is a full-access key on chain; skipped`);
      continue;
    }
    if (existsSync(keyFileOf(id))) throw new Error(`${id} is free but ${keyFileOf(id)} already exists; not overwriting it: stopping`);
    plan.push([k, id]);
    show(id, [`CreateAccount`, `Transfer ${FUND[k]} NEAR`, `AddKey <new ed25519 key>, FullAccess`]);
  }
  if (!plan.length) console.log("  nothing to create");
  if (execute) {
    for (const [k, id] of plan) {
      if (await exists(id)) throw new Error(`${id} appeared while D1 was running: stopping`);
      const need = await remainingNeed();
      if ((await balanceOf(MASTER)) < need) throw new Error(`master balance too low for the rest of D1 (needs ${near(need)} NEAR)`);
      const kp = KeyPair.fromRandom("ed25519");
      // "wx": fails if the file exists, so a key file is never overwritten
      writeFileSync(keyFileOf(id), JSON.stringify({ account_id: id, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600, flag: "wx" });
      await send(MASTER, id, [actions.createAccount(), actions.transfer(nearToYocto(FUND[k])), actions.addFullAccessKey(kp.getPublicKey())]);
    }
  }
}
if (step === "D2") {
  const args = { admin: MASTER, pauser: MASTER, config: CONFIG };
  console.log(`D2: deploy the receipt contract (wasm ${PINNED.receipts}, ${readFileSync(WASM.receipts).length} bytes) to ${ids.receipts} and initialise it. Code storage alone is about ${(readFileSync(WASM.receipts).length / 100000).toFixed(3)} testnet NEAR at 1e19 yocto per byte, plus state and gas; funded ${FUND.receipts} in D1. This initializes the compatibility v2 path, not the v3 migration; follow UPGRADE_V3.md for v3.`);
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
