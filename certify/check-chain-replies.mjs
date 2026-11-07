// CI guard (owner decision 7 Nov): decode EVERY submit_verdict transaction ever sent to the live contract,
// successful or failed, and fail if any reply carries a key or value outside the allowed list (tee/reply.mjs).
// A failed call still publishes its arguments, so failed transactions are checked too.
//
//   npm run check:chain-replies                      (live contract from web/chain.mjs)
//   TRUENAV_CONTRACT=registry.<name>.testnet npm run check:chain-replies
//
// Transaction list: FastNEAR transactions API (POST /v0/account, paged with resume_token; full transactions from
// POST /v0/transactions, up to 20 hashes per call; see docs.fastnear.com/tx). No key needed.
import { replyProblem } from "../tee/reply.mjs";
import { DEFAULT_CONTRACT } from "../web/chain.mjs";

const contract = process.env.TRUENAV_CONTRACT || DEFAULT_CONTRACT;
const network = contract.endsWith(".near") ? "main" : "test";
const API = process.env.TRUENAV_TX_API || `https://tx.${network}.fastnear.com`;

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

const hashes = [];
let resume_token;
for (let page = 0; page < 1000; page++) {
  const j = await post("/v0/account", { account_id: contract, is_function_call: true, limit: 200, ...(resume_token ? { resume_token } : {}) });
  for (const row of j.account_txs || []) hashes.push(row.transaction_hash);
  if (!j.account_txs || j.account_txs.length === 0 || !j.resume_token || j.resume_token === resume_token) break;
  resume_token = j.resume_token;
}
const unique = [...new Set(hashes)];

let verdictCalls = 0;
const bad = [];
for (let i = 0; i < unique.length; i += 20) {
  const j = await post("/v0/transactions", { tx_hashes: unique.slice(i, i + 20) });
  for (const t of j.transactions || []) {
    const tx = t.transaction;
    if (tx.receiver_id !== contract) continue;
    for (const a of tx.actions || []) {
      const fc = a.FunctionCall;
      if (!fc || fc.method_name !== "submit_verdict") continue;
      verdictCalls++;
      let problem;
      try {
        const args = JSON.parse(Buffer.from(fc.args, "base64").toString("utf8"));
        problem = typeof args.response_body === "string" ? replyProblem(args.response_body) : "no response_body";
      } catch {
        problem = "arguments are not JSON";
      }
      if (problem) bad.push({ tx: tx.hash, problem });
    }
    // Delegated (meta) transactions would hide the call inside a Delegate action; the servicer never uses them.
    if ((tx.actions || []).some((a) => a.Delegate)) bad.push({ tx: tx.hash, problem: "delegate action: not checked, inspect by hand" });
  }
}

console.log(`${contract}: ${unique.length} function-call transactions, ${verdictCalls} submit_verdict calls decoded (successful and failed)`);
for (const b of bad.slice(0, 20)) console.log(`FAIL ${b.tx}: ${b.problem}`);
if (bad.length > 20) console.log(`... and ${bad.length - 20} more`);
if (unique.length === 0) console.log("FAIL no transactions found: indexer empty or wrong contract");
console.log(bad.length === 0 && unique.length > 0 ? "PASS every submit_verdict reply is within the allowed keys" : `FAIL ${bad.length} replies outside the allowed keys`);
process.exitCode = bad.length === 0 && unique.length > 0 ? 0 : 1;
