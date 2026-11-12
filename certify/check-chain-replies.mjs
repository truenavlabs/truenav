// CI guard on live chain data (owner decisions 7 Nov). Decodes EVERY submit_verdict call that reached the live
// contract, successful or failed, direct or through another contract or a delegated (meta) transaction, and checks
// each reply against the allowed keys (tee/reply.mjs). A failed call still publishes its arguments.
//   - calls whose signer (or predecessor) is one of our accounts: any problem FAILS the check (D4)
//   - calls from foreign accounts: listed as warnings, never a failure (anyone can send junk; D4)
// Our accounts: the contract's parent account and its sub-accounts, plus the current role holders (get_roles).
//
//   npm run check:chain-replies                                              the current registry (tee/status.json)
//   npm run check:chain-replies -- --contract registry.tnlab-718ca9.testnet    the earlier instance
//   (TRUENAV_CONTRACT=registry.<name>.testnet still works)
//
// Transaction list: FastNEAR transactions API (POST /v0/account, paged with resume_token; full transactions with
// their receipts from POST /v0/transactions, up to 20 hashes per call; see docs.fastnear.com/tx). No key needed.
import { replyShapeProblem, verdictConsistencyProblem } from "../tee/reply.mjs";
import { DEFAULT_RPC, view } from "../web/chain.mjs";

/** Every submit_verdict call to `contract` inside one FastNEAR transaction record (receipts first, then actions). */
export function verdictCalls(t, contract) {
  const out = [];
  for (const r of t.receipts || []) {
    const rc = r.receipt || {};
    const action = rc.receipt && rc.receipt.Action;
    if (rc.receiver_id !== contract || !action) continue;
    const outcome = outcomeOf(r.execution_outcome && r.execution_outcome.outcome && r.execution_outcome.outcome.status);
    for (const a of action.actions || []) {
      const fc = a.FunctionCall;
      if (fc && fc.method_name === "submit_verdict") out.push({ tx: t.transaction.hash, signer: action.signer_id, predecessor: rc.predecessor_id, args: fc.args, outcome });
    }
  }
  // A transaction not yet executed has no receipts: fall back to its own actions.
  if (!(t.receipts || []).length && t.transaction.receiver_id === contract) {
    for (const a of t.transaction.actions || []) {
      const fc = a.FunctionCall;
      if (fc && fc.method_name === "submit_verdict") out.push({ tx: t.transaction.hash, signer: t.transaction.signer_id, predecessor: t.transaction.signer_id, args: fc.args, outcome: "unknown" });
    }
  }
  return out;
}

/** "success", "failure" or "unknown" from a receipt outcome status. */
export function outcomeOf(status) {
  if (!status || typeof status !== "object") return "unknown";
  if ("Failure" in status) return "failure";
  if ("SuccessValue" in status || "SuccessReceiptId" in status) return "success";
  return "unknown";
}

const responseBodyOf = (argsBase64) => {
  try {
    const args = JSON.parse(Buffer.from(argsBase64, "base64").toString("utf8"));
    return typeof args.response_body === "string" ? { body: args.response_body } : { problem: "no response_body" };
  } catch {
    return { problem: "arguments are not JSON" };
  }
};

/** The shape and allowed-keys problem in one call's base64 arguments, or null. Applies to every call, refused or not. */
export function callProblem(argsBase64) {
  const r = responseBodyOf(argsBase64);
  return r.problem ?? replyShapeProblem(r.body);
}

/**
 * How one decoded call is judged: { level: "fail" | "warn" | null, problem }. The shape rule is a FAIL on every call.
 * The verdict-consistency rule (N-04) is a FAIL on a call that succeeded, a WARN on a call refused on chain (nothing was
 * stored), and a FAIL when the outcome cannot be read.
 */
export function judgeCall(call) {
  const shape = callProblem(call.args);
  if (shape) return { level: "fail", problem: shape };
  const consistency = verdictConsistencyProblem(responseBodyOf(call.args).body);
  if (!consistency) return { level: null, problem: null };
  if (call.outcome === "failure") return { level: "warn", problem: `${consistency} (refused on chain)` };
  if (call.outcome === "success") return { level: "fail", problem: consistency };
  return { level: "fail", problem: `${consistency}; the on-chain outcome could not be read` };
}

export const isOurs = (account, parent, roleHolders) => !!account && (account === parent || account.endsWith(`.${parent}`) || roleHolders.includes(account));

async function main() {
  // The contract follows tee/status.json: the current registry once it says live, the earlier instance (which holds the
  // other recorded history) through --contract or TRUENAV_CONTRACT. No environment variable is needed for the default.
  const { flag } = await import("../tee/recorded-set.mjs");
  const { readStatus } = await import("../tee/status.mjs");
  const status = readStatus();
  const contract = flag(process.argv.slice(2), "--contract") || process.env.TRUENAV_CONTRACT || (status.tee === "live" ? status.registry : status.earlier_instance);
  const network = contract.endsWith(".near") ? "main" : "test";
  const API = process.env.TRUENAV_TX_API || `https://tx.${network}.fastnear.com`;
  const parent = contract.split(".").slice(1).join(".");
  const roles = await view(contract, "get_roles", {}, process.env.TRUENAV_RPC || DEFAULT_RPC);
  const roleHolders = [roles.admin, roles.registrar, roles.pauser, roles.servicer].filter(Boolean);

  async function post(path, body) {
    for (let i = 0; i < 4; i++) {
      try {
        const r = await fetch(`${API}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (r.ok) return await r.json();
        if (r.status < 500 && r.status !== 429) throw new Error(`${path} ${r.status}: ${(await r.text()).slice(0, 200)}`);
      } catch (e) {
        if (i === 3) throw e;
      }
      await new Promise((res) => setTimeout(res, 2000 * (i + 1)));
    }
    throw new Error(`${path} failed`);
  }

  // Every transaction in which the contract appears (no filter: direct calls, receipts from other contracts).
  const hashes = [];
  let resume_token;
  for (let page = 0; page < 1000; page++) {
    const j = await post("/v0/account", { account_id: contract, limit: 200, ...(resume_token ? { resume_token } : {}) });
    for (const row of j.account_txs || []) hashes.push(row.transaction_hash);
    if (!j.account_txs || j.account_txs.length === 0 || !j.resume_token || j.resume_token === resume_token) break;
    resume_token = j.resume_token;
  }
  const unique = [...new Set(hashes)];

  const ours = [];
  const foreign = [];
  for (let i = 0; i < unique.length; i += 20) {
    const j = await post("/v0/transactions", { tx_hashes: unique.slice(i, i + 20) });
    for (const t of j.transactions || []) {
      for (const c of verdictCalls(t, contract)) {
        const own = isOurs(c.signer, parent, roleHolders) || isOurs(c.predecessor, parent, roleHolders);
        const j = judgeCall(c);
        (own ? ours : foreign).push({ ...c, level: j.level, problem: j.problem });
      }
    }
  }

  const bad = ours.filter((c) => c.level === "fail");
  const warned = ours.filter((c) => c.level === "warn");
  console.log(`${contract}: ${unique.length} transactions, ${ours.length + foreign.length} submit_verdict calls decoded (successful and failed): ${ours.length} from our accounts, ${foreign.length} foreign`);
  for (const c of foreign.filter((x) => x.problem)) console.log(`WARN foreign ${c.tx} from ${c.signer}: ${c.problem}`);
  for (const w of warned) console.log(`WARN ${w.tx} (refused on chain) from ${w.signer}: ${w.problem.replace(/ \(refused on chain\)$/, "")}`);
  for (const b of bad.slice(0, 20)) console.log(`FAIL ${b.tx} from ${b.signer}: ${b.problem}`);
  if (unique.length === 0) console.log("FAIL no transactions found: indexer empty or wrong contract");
  const ok = bad.length === 0 && unique.length > 0;
  console.log(ok ? "PASS every submit_verdict reply from our accounts is within the allowed keys" : `FAIL ${bad.length} replies from our accounts break the reply rule`);
  process.exitCode = ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
