// Record the evidence ledger (web/data/recorded/evidence-ledger.json): the real testnet transactions the README and
// docs point to. Each one is read from the public archival testnet RPC (EXPERIMENTAL_tx_status and the block header)
// and cross-checked against NearBlocks (read only). The block time is recorded in UTC. The file is hashed like
// judge-replay.json: the generated-at time sits outside evidence_hash.
//
//   npm run record:ledger       needs network. Writes nothing if any transaction is missing, not final, differs between
//                               the two sources, or is not what its entry says.
//
// A transaction hash here is only ever copied from the repository's own README and docs.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { canonical } from "../../judge/lib.mjs";

export const LEDGER_SCHEMA = "truenav-evidence-ledger/v1";
export const LEDGER_PATH = "web/data/recorded/evidence-ledger.json";
const RPC_URL = "https://archival-rpc.testnet.near.org";
const NEARBLOCKS = "https://api-testnet.nearblocks.io/v1/txns/";
const REGISTRY = "registry.tnlab-368aa2.testnet";

/** The six transactions, in time order. `expect` is what the entry claims; the build fails if the chain says otherwise. */
export const ENTRIES = [
  { id: "registry_deploy", tx_hash: "Hx1Gcbcoq3F7W5DDUYtgLoEsyKVPeVcn7vZ19Hy4BkXE", label: "Live registry deployed and initialised", shows: "The contract that holds pledges, verdicts and certificates went live. Its code hash is compared with the repository pin in docs/DEPLOYMENT_EVIDENCE.md.", docs: ["README.md", "docs/DEPLOYMENT_EVIDENCE.md"], expect: { receiver: REGISTRY, actions: ["DEPLOY_CONTRACT", "new"], status: "success" } },
  { id: "refused_signer_not_registered", tx_hash: "Gbu7tKHuE2WVfSMduS1MNyuMRf6TQSQyou2gr9ozXrnQ", label: "Certificate from an unregistered signer refused", shows: "A certificate signed with a public test key was refused by the contract. Only registered certificate signers are accepted.", docs: ["README.md", "docs/TRY_IT.md"], expect: { receiver: REGISTRY, actions: ["submit_certificate"], status: "failure", result: "signer not registered" } },
  { id: "refused_already_pledged", tx_hash: "8VK1kUkpa7Gs8dStznffdDAM9uHVbfodHWBUvbfQMwrs", label: "Second pledge of an already pledged loan refused", shows: "A second fund pledged a loan another fund already held. The contract returned a refusal, stored one blocked attempt and one alert, and did not name the holder.", docs: ["README.md", "docs/KNOWN_LIMITS.md", "docs/TRY_IT.md"], expect: { receiver: REGISTRY, actions: ["pledge_loan"], status: "success", result: "refused: already pledged elsewhere" } },
  { id: "tee_signer_registered", tx_hash: "9pWmjgBKN37VzMVBUo8vw3ygJ3PsPtnhp5D7wczaktvE", label: "TEE signer registered", shows: "The registrar registered the NEAR AI Cloud model key with the hash of its attestation report, after the off chain check that npm run verify:attestation repeats.", docs: ["README.md", "docs/DEPLOYMENT_EVIDENCE.md", "docs/TEE_STATUS.md"], expect: { receiver: REGISTRY, actions: ["add_tee_signer"], status: "success" } },
  { id: "query_redeploy", tx_hash: "2UjogapG3eALhSTjq6GXiaymrqGBvBVX8ZrFbvGjhnq8", label: "Query contract redeployed to its pinned build", shows: "A code only redeploy of the paid query contract to the pinned wasm. Its live code hash now matches the pin in receipts/pinned-builds.json.", docs: ["README.md", "docs/DEPLOYMENT_EVIDENCE.md"], expect: { receiver: "query.tnlab-718ca9.testnet", actions: ["DEPLOY_CONTRACT"], status: "success" } },
  { id: "registry_storage_topup", tx_hash: "7wjnse7nQxVyZLn29RRH4nxQmVGCNfWDBkucnSwC5Eka", label: "Registry storage top up", shows: "1 testnet NEAR sent to the registry so wallet writes from a judge do not run out of storage. No mainnet funds.", docs: ["docs/KNOWN_LIMITS.md"], expect: { receiver: REGISTRY, signer: "tnlab-368aa2.testnet", actions: ["TRANSFER 1 NEAR"], status: "success" } },
];

export function ledgerHash(ledger) {
  const { ephemeral, evidence_hash, ...hashed } = ledger;
  return createHash("sha256").update(canonical(hashed)).digest("hex");
}

const near = (yocto) => {
  const s = BigInt(yocto).toString().padStart(25, "0");
  const whole = s.slice(0, -24).replace(/^0+(?=\d)/, "");
  const frac = s.slice(-24).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
};

function actionText(a) {
  if ("DeployContract" in a) return "DEPLOY_CONTRACT";
  if ("FunctionCall" in a) return a.FunctionCall.method_name;
  if ("Transfer" in a) return `TRANSFER ${near(a.Transfer.deposit)} NEAR`;
  return Object.keys(a)[0].replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();
}

function outcomeOf(status) {
  if (status && "SuccessValue" in status) {
    const raw = Buffer.from(status.SuccessValue || "", "base64").toString("utf8");
    if (!raw) return { status: "success", result: "ok, no return value" };
    try {
      const v = JSON.parse(raw);
      if (v && typeof v === "object" && typeof v.outcome === "string") return { status: "success", result: `${v.outcome}${v.message ? `: ${v.message}` : ""}` };
    } catch { /* not JSON: fall through */ }
    return { status: "success", result: "ok, returned a value" };
  }
  if (status && "Failure" in status) {
    const k = status.Failure?.ActionError?.kind;
    const msg = k?.FunctionCallError?.ExecutionError ?? JSON.stringify(k ?? status.Failure);
    return { status: "failure", result: String(msg).slice(0, 300) };
  }
  return { status: "unknown", result: JSON.stringify(status).slice(0, 120) };
}

/** Build the ledger. `fetchers` = { rpc(method, params) -> result, nearblocks(hash) -> parsed JSON }. */
export async function buildLedger({ entries, fetchers, now }) {
  const out = [];
  for (const e of entries) {
    const nbr = (await fetchers.nearblocks(e.tx_hash)).txns?.[0];
    if (!nbr) throw new Error(`${e.id}: ${e.tx_hash} not found on NearBlocks`);
    const tx = await fetchers.rpc("EXPERIMENTAL_tx_status", { tx_hash: e.tx_hash, sender_account_id: nbr.signer_account_id, wait_until: "FINAL" });
    if (tx.final_execution_status !== "FINAL") throw new Error(`${e.id}: transaction is not final (${tx.final_execution_status})`);
    const blockHash = tx.transaction_outcome.block_hash;
    const header = (await fetchers.rpc("block", { block_id: blockHash })).header;
    const ns = String(header.timestamp_nanosec);
    const actions = tx.transaction.actions.map(actionText).join(" + ");
    const outcome = outcomeOf(tx.status);
    const agree = nbr.signer_account_id === tx.transaction.signer_id && nbr.receiver_account_id === tx.transaction.receiver_id
      && Number(nbr.block?.block_height) === Number(header.height) && String(nbr.block_timestamp) === ns && nbr.transaction_hash === e.tx_hash;
    if (!agree) throw new Error(`${e.id}: RPC and NearBlocks disagree on signer, receiver, block height or block time`);
    const x = e.expect;
    if (tx.transaction.receiver_id !== x.receiver) throw new Error(`${e.id}: receiver is ${tx.transaction.receiver_id}, expected ${x.receiver}`);
    if (x.signer && tx.transaction.signer_id !== x.signer) throw new Error(`${e.id}: signer is ${tx.transaction.signer_id}, expected ${x.signer}`);
    if (outcome.status !== x.status) throw new Error(`${e.id}: status is ${outcome.status}, expected ${x.status}`);
    for (const a of x.actions) if (!actions.includes(a)) throw new Error(`${e.id}: actions "${actions}" do not include "${a}"`);
    if (x.result && !outcome.result.includes(x.result)) throw new Error(`${e.id}: result "${outcome.result}" does not include "${x.result}"`);
    out.push({
      id: e.id,
      label: e.label,
      shows: e.shows,
      tx_hash: e.tx_hash,
      signer: tx.transaction.signer_id,
      receiver: tx.transaction.receiver_id,
      actions,
      outcome,
      block_height: Number(header.height),
      block_hash: blockHash,
      block_time_ns: ns,
      block_time_utc: new Date(Number(BigInt(ns) / 1_000_000n)).toISOString(),
      explorer_url: `https://testnet.nearblocks.io/txns/${e.tx_hash}`,
      explorer_alt_url: `https://explorer.testnet.near.org/transactions/${e.tx_hash}`,
      docs: e.docs,
      verified: { rpc: "archival-rpc.testnet.near.org", cross_check: "api-testnet.nearblocks.io", agree: true },
    });
  }
  const ledger = { schema: LEDGER_SCHEMA, network: "testnet", entries: out, ephemeral: { generated_at: now } };
  ledger.evidence_hash = ledgerHash(ledger);
  return ledger;
}

async function getJson(url, init, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, init);
      if (r.ok) return await r.json();
      last = new Error(`${url} answered ${r.status}`);
    } catch (e) { last = e; }
    await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
  }
  throw last;
}

const realFetchers = {
  nearblocks: (hash) => getJson(NEARBLOCKS + hash),
  rpc: async (method, params) => {
    const j = await getJson(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 200)}`);
    return j.result;
  },
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const ledger = await buildLedger({ entries: ENTRIES, fetchers: realFetchers, now: new Date().toISOString() });
    writeFileSync(new URL(`../../${LEDGER_PATH}`, import.meta.url), JSON.stringify(ledger, null, 2) + "\n");
    for (const e of ledger.entries) console.log(`${e.block_time_utc}  block ${e.block_height}  ${e.id}  ${e.outcome.status}  ${e.tx_hash}`);
    console.log(`recorded ${LEDGER_PATH}, evidence_hash ${ledger.evidence_hash}`);
  } catch (e) {
    console.error(`not recorded: ${e.message}`);
    process.exit(1);
  }
}
