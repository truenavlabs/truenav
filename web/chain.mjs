// Read TrueNav state from the NEAR registry contract over JSON-RPC. No dependencies: runs in the browser and in
// Node 18+. Read only: no keys, no transactions.
//
// loadChainState() returns what an investor needs to recompute a fund's score from chain data:
// latest certificate per fund, TEE verdict store per loan (pledge time, latest verdict, flag history),
// pledge holder per loan, blocked attempts and alerts per fund, registered signers, and the deployed code hash.

export const DEFAULT_RPC = "https://test.rpc.fastnear.com"; // public testnet RPC (docs.near.org RPC providers)
export const DEFAULT_CONTRACT = "registry.tnlab-07775b.testnet";

async function rpc(url, method, params) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "truenav", method, params }) });
  if (!r.ok) throw new Error(`RPC ${method} failed: HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`RPC ${method} failed: ${j.error.message || JSON.stringify(j.error).slice(0, 200)}`);
  return j.result;
}

const b64 = (s) => (typeof btoa === "function" ? btoa(s) : Buffer.from(s, "utf8").toString("base64"));
const utf8 = (bytes) => new TextDecoder().decode(new Uint8Array(bytes));

/** Call a view method; returns the parsed JSON result. */
export async function view(contract, method, args = {}, url = DEFAULT_RPC) {
  const res = await rpc(url, "query", { request_type: "call_function", finality: "final", account_id: contract, method_name: method, args_base64: b64(JSON.stringify(args)) });
  return JSON.parse(utf8(res.result));
}

export async function codeHash(contract, url = DEFAULT_RPC) {
  return (await rpc(url, "query", { request_type: "view_account", finality: "final", account_id: contract })).code_hash;
}

/** Run promise-returning jobs with a small concurrency limit (public RPCs rate limit bursts). */
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

/**
 * @param {object} p
 * @param {string[]} p.funds   fund ids
 * @param {{fund_id:string, loan_id:string, loan_hash:string}[]} p.loans  pledged demo loans
 */
export async function loadChainState({ funds, loans, contract = DEFAULT_CONTRACT, url = DEFAULT_RPC }) {
  const v = (m, a) => view(contract, m, a, url);
  const [hash, sourceMetadata, signers, teeSigners] = await Promise.all([codeHash(contract, url), v("contract_source_metadata").catch(() => null), v("get_signers"), v("get_tee_signers")]);
  const fundRows = await pool(funds.map((f) => async () => ({
    fund_id: f,
    registered: await v("get_fund", { fund_id: f }),
    certificate: await v("get_latest_certificate", { fund_id: f }),
    certificates: await v("get_certificate_count", { fund_id: f }),
    attempts: (await v("get_attempts_page", { fund_id: f, from_index: 0, limit: 1 })).count,
    alerts: await v("get_alert_count", { fund_id: f }),
  })));
  const loanRows = await pool(loans.map((l) => async () => {
    const [lock, latest, verdicts, flags, token] = await Promise.all([
      v("get_lock", { loan_hash: l.loan_hash }),
      v("get_latest_verdict", { loan_hash: l.loan_hash }),
      v("get_verdict_count", { loan_hash: l.loan_hash }),
      v("get_flag_count", { loan_hash: l.loan_hash }),
      v("nft_token", { token_id: l.loan_hash }),
    ]);
    return { ...l, lock, latest, verdicts, flags, holder: token ? token.owner_id : null };
  }));
  // The engine's TEE verdict store (NAV_SPEC R25): latest verdict counts, pledge time starts the 7-day grace.
  const teeStore = {};
  for (const l of loanRows) {
    if (!l.lock) continue;
    teeStore[l.loan_hash] = { pledged_at_ms: l.lock.locked_at_ms, latest: l.latest ? { verdict: l.latest.verdict, anomalies: l.latest.anomalies, at_ms: l.latest.at_ms } : null };
  }
  return { contract, rpc: url, codeHash: hash, sourceMetadata, signers, teeSigners, funds: fundRows, loans: loanRows, teeStore, readAt: new Date().toISOString() };
}
