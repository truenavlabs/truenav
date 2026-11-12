// Live registry reader for the web app. Framework-free, browser and Node 22, no dependencies.
// Read only: view calls, view_account and block queries over public NEAR testnet JSON-RPC. No keys, no transactions.
//
// loadRegistry() returns everything the app shows about the registry, plus how the read went:
//   state "live"     every call answered during this load
//   state "partial"  some calls failed; those fields are null and listed in errors
//   state "offline"  nothing answered; callers show recorded evidence only and never fill live cells from it
import { DEFAULT_CONTRACT, DEFAULT_RPC, BACKUP_RPCS } from "../chain.mjs";

export { DEFAULT_CONTRACT, DEFAULT_RPC };
/** Funds the demo registers. The contract has no list view, so ids are known; each is checked with get_fund. */
export const FUND_IDS = Object.freeze(["harbor-credit-fund", "meridian-yield-fund"]);
export const TIMEOUT_MS = 8000;

const b64 = (s) => {
  let bin = "";
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
};
const utf8 = (bytes) => new TextDecoder().decode(new Uint8Array(bytes));

/** A JSON-RPC client that remembers the endpoint that answered and the newest block it saw. */
export function makeRpc({ url = DEFAULT_RPC, fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const urls = url === DEFAULT_RPC ? [DEFAULT_RPC, ...BACKUP_RPCS] : [url];
  const seen = { endpoint: null, block: null, calls: 0 };
  async function once(u, method, params) {
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    try {
      const r = await fetchImpl(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "truenav-web", method, params }), signal: ctl ? ctl.signal : undefined });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j.error) {
        const e = new Error(j.error.cause?.info?.error_message || j.error.message || JSON.stringify(j.error).slice(0, 200));
        e.contractError = j.error.name === "HANDLER_ERROR" || /does not exist|CodeDoesNotExist|wasm execution failed/i.test(JSON.stringify(j.error));
        throw e;
      }
      return j.result;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async function call(method, params) {
    let last;
    for (const u of urls) {
      try {
        const res = await once(u, method, params);
        seen.endpoint = u;
        seen.calls++;
        if (res && Number.isSafeInteger(res.block_height) && (!seen.block || res.block_height > seen.block.height)) seen.block = { height: res.block_height, hash: res.block_hash };
        return res;
      } catch (e) {
        last = e;
        if (e.contractError) throw e;
      }
    }
    throw last || new Error("no RPC endpoint");
  }
  return { call, seen, urls };
}

/** One view call. Returns parsed JSON. */
export async function viewCall(rpc, contract, method, args = {}) {
  const res = await rpc.call("query", { request_type: "call_function", finality: "final", account_id: contract, method_name: method, args_base64: b64(JSON.stringify(args)) });
  return JSON.parse(utf8(res.result));
}

async function pool(jobs, limit = 4) {
  const out = new Array(jobs.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (i < jobs.length) {
      const k = i++;
      out[k] = await jobs[k]();
    }
  }));
  return out;
}

const parseExtra = (s) => {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
};

/** Exact text of a view call, for "copy RPC call" buttons and source hovers. */
export const callText = (method, args = {}) => `${method}(${JSON.stringify(args)})`;

/**
 * Read the whole registry.
 * @param {{contract?:string, url?:string, fetchImpl?:Function, fundIds?:string[], now?:()=>number}} [p]
 */
export async function loadRegistry({ contract = DEFAULT_CONTRACT, url = DEFAULT_RPC, fetchImpl, fundIds = FUND_IDS, now = () => Date.now() } = {}) {
  const rpc = makeRpc({ url, fetchImpl });
  const errors = [];
  let attempted = 0;
  const safe = async (label, fn) => {
    attempted++;
    try {
      return await fn();
    } catch (e) {
      errors.push({ call: label, message: e && e.message ? e.message : String(e) });
      return null;
    }
  };
  const v = (m, a = {}) => safe(callText(m, a), () => viewCall(rpc, contract, m, a));

  const startedAt = now();
  const [block, account, roles, signers, teeSigners, pledgeKey, pledgeSigners, totalSupply, metadata, sourceMetadata] = await Promise.all([
    safe("block(final)", () => rpc.call("block", { finality: "final" })),
    safe(`view_account(${contract})`, () => rpc.call("query", { request_type: "view_account", finality: "final", account_id: contract })),
    v("get_roles"), v("get_signers"), v("get_tee_signers"), v("get_servicer_pledge_key"), v("get_pledge_signers"),
    v("nft_total_supply"), v("nft_metadata"), v("contract_source_metadata"),
  ]);

  const funds = await pool(fundIds.map((fund_id) => async () => {
    const [fund, certificate, certCount, certHistory, attempts, alerts, alertCount] = [
      await v("get_fund", { fund_id }),
      await v("get_latest_certificate", { fund_id }),
      await v("get_certificate_count", { fund_id }),
      await v("get_certificate_history_page", { fund_id, from_index: 0, limit: 50 }),
      await v("get_attempts_page", { fund_id, from_index: 0, limit: 50 }),
      await v("get_alerts_page", { fund_id, from_index: 0, limit: 50 }),
      await v("get_alert_count", { fund_id }),
    ];
    return { fund_id, fund, certificate, certCount, certHistory, attempts, alerts, alertCount };
  }));

  // Enumerate every pledge token (no loans.json needed), then read each loan's lock and verdict state.
  const tokens = [];
  const pageSize = 50;
  for (let from = 0; from < 1000; from += pageSize) {
    const page = await v("nft_tokens", { from_index: String(from), limit: pageSize });
    if (!Array.isArray(page)) break;
    tokens.push(...page);
    if (page.length < pageSize) break;
  }
  const loans = await pool(tokens.map((t) => async () => {
    const loan_hash = t.token_id;
    const [lock, latest, verdictCount, flagCount] = await Promise.all([
      v("get_lock", { loan_hash }), v("get_latest_verdict", { loan_hash }), v("get_verdict_count", { loan_hash }), v("get_flag_count", { loan_hash }),
    ]);
    const extra = parseExtra(t.metadata && t.metadata.extra);
    return {
      loan_hash, owner_id: t.owner_id, asset_type: extra.asset_type || null,
      issued_at_ms: t.metadata && t.metadata.issued_at ? Number(t.metadata.issued_at) : null,
      fund_id: lock ? lock.fund_id : null, lock, latest, verdictCount, flagCount, token: t,
    };
  }));

  const state = errors.length === 0 ? "live" : errors.length >= attempted ? "offline" : "partial";
  return {
    contract, network: "testnet", state, errors, attempted,
    rpc: rpc.seen.endpoint, block: rpc.seen.block || (block ? { height: block.header.height, hash: block.header.hash } : null),
    blockTime: block ? Math.round(Number(block.header.timestamp_nanosec || block.header.timestamp) / 1e6) : null,
    readAt: new Date(now()).toISOString(), durationMs: now() - startedAt,
    codeHash: account ? account.code_hash : null, storageBytes: account ? account.storage_usage : null,
    roles, signers, teeSigners, pledgeKey, pledgeSigners, totalSupply: totalSupply === null ? null : Number(totalSupply), metadata, sourceMetadata,
    funds, loans,
  };
}

/** Everything about one loan: token, lock, full verdict history. */
export async function loadLoan(loan_hash, { contract = DEFAULT_CONTRACT, url = DEFAULT_RPC, fetchImpl } = {}) {
  const rpc = makeRpc({ url, fetchImpl });
  const v = (m, a) => viewCall(rpc, contract, m, a);
  const [token, lock, count, flags, latest] = await Promise.all([v("nft_token", { token_id: loan_hash }), v("get_lock", { loan_hash }), v("get_verdict_count", { loan_hash }), v("get_flag_count", { loan_hash }), v("get_latest_verdict", { loan_hash })]);
  const verdicts = count ? await v("get_verdicts_page", { loan_hash, from_index: 0, limit: Math.min(count, 50) }) : [];
  return { loan_hash, token, lock, verdictCount: count, flagCount: flags, latest, verdicts, readAt: new Date().toISOString(), rpc: rpc.seen.endpoint, block: rpc.seen.block };
}

/** Any testnet account: pledge tokens it holds and whether it is a registered fund or holds a role. */
export async function loadAccount(account_id, { contract = DEFAULT_CONTRACT, url = DEFAULT_RPC, fetchImpl, fundIds = FUND_IDS } = {}) {
  if (!/^[a-z0-9._-]{2,64}$/.test(String(account_id))) throw new Error("not a NEAR account id");
  if (!String(account_id).endsWith(".testnet") && !/^[0-9a-f]{64}$/.test(account_id)) throw new Error("testnet accounts only (ending in .testnet)");
  const rpc = makeRpc({ url, fetchImpl });
  const v = (m, a) => viewCall(rpc, contract, m, a);
  const [tokens, supply, roles, funds] = await Promise.all([
    v("nft_tokens_for_owner", { account_id, from_index: "0", limit: 100 }), v("nft_supply_for_owner", { account_id }), v("get_roles"),
    Promise.all(fundIds.map((f) => v("get_fund", { fund_id: f }))),
  ]);
  const fund = funds.find((f) => f && f.account_id === account_id) || null;
  const roleNames = roles ? ["admin", "registrar", "pauser", "servicer"].filter((r) => roles[r] === account_id) : [];
  return { account_id, tokens, supply: Number(supply), fund, roles: roleNames, readAt: new Date().toISOString(), rpc: rpc.seen.endpoint, block: rpc.seen.block };
}

/** Raw view call for the Data page: returns the parsed JSON and the call text. */
export async function rawView(method, args = {}, { contract = DEFAULT_CONTRACT, url = DEFAULT_RPC, fetchImpl } = {}) {
  const rpc = makeRpc({ url, fetchImpl });
  const result = await viewCall(rpc, contract, method, args);
  return { call: callText(method, args), result, rpc: rpc.seen.endpoint, block: rpc.seen.block, readAt: new Date().toISOString() };
}

/** View methods the Data page lists, with example args. */
export const VIEW_METHODS = Object.freeze([
  ["get_roles", {}], ["get_signers", {}], ["get_servicer_pledge_key", {}], ["get_pledge_signers", {}], ["get_tee_signers", {}],
  ["get_fund", { fund_id: "meridian-yield-fund" }], ["get_latest_certificate", { fund_id: "meridian-yield-fund" }],
  ["get_certificate_count", { fund_id: "meridian-yield-fund" }], ["get_certificate_history_page", { fund_id: "meridian-yield-fund", from_index: 0, limit: 10 }],
  ["get_attempts_page", { fund_id: "meridian-yield-fund", from_index: 0, limit: 10 }], ["get_alerts_page", { fund_id: "meridian-yield-fund", from_index: 0, limit: 10 }],
  ["get_alert_count", { fund_id: "meridian-yield-fund" }],
  ["get_lock", { loan_hash: "33b1021e2f696e6a5832226e6512df342213901fdc889c9e189f93db6f89cedc" }],
  ["get_latest_verdict", { loan_hash: "33b1021e2f696e6a5832226e6512df342213901fdc889c9e189f93db6f89cedc" }],
  ["get_verdict_count", { loan_hash: "33b1021e2f696e6a5832226e6512df342213901fdc889c9e189f93db6f89cedc" }],
  ["get_verdicts_page", { loan_hash: "33b1021e2f696e6a5832226e6512df342213901fdc889c9e189f93db6f89cedc", from_index: 0, limit: 10 }],
  ["get_flag_count", { loan_hash: "33b1021e2f696e6a5832226e6512df342213901fdc889c9e189f93db6f89cedc" }],
  ["pledge_message_used", { message: "paste a signed pledge message" }],
  ["nft_token", { token_id: "33b1021e2f696e6a5832226e6512df342213901fdc889c9e189f93db6f89cedc" }],
  ["nft_tokens", { from_index: "0", limit: 20 }], ["nft_tokens_for_owner", { account_id: "harbor.tnlab-368aa2.testnet", from_index: "0", limit: 20 }],
  ["nft_supply_for_owner", { account_id: "harbor.tnlab-368aa2.testnet" }], ["nft_total_supply", {}], ["nft_metadata", {}], ["contract_source_metadata", {}],
]);
