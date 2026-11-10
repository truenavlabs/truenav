// CLI for the demo agent. Testnet only (the RPC's chain id is checked). Without --execute it only reads (views) and
// prints the decision and the exact buy_query it would send; nothing is signed. With --execute it buys one report
// entitlement for the fee, signed by the agent's OWN account (never the shared TrueNav accounts).
//
//   node agent/run.mjs <TOKEN> [--execute] [--api <url>]
//   env: TRUENAV_AGENT_ACCOUNT, TRUENAV_AGENT_KEYFILE (needed for --execute; key file account_id must match)
//        TRUENAV_MASTER (default tnlab-718ca9.testnet): the contracts are receipts.<master> and query.<master>
import { randomBytes } from "node:crypto";
import { agentChain } from "./chain.mjs";
import { runAgent, summary, newRequestId } from "./agent.mjs";
import { validToken } from "../api/receipt.mjs";

const RPC = "https://rpc.testnet.near.org";
const MASTER = process.env.TRUENAV_MASTER || "tnlab-718ca9.testnet";
const receipts = `receipts.${MASTER}`;
const query = `query.${MASTER}`;
const SHARED = [MASTER, receipts, query, `runner.${MASTER}`, `api.${MASTER}`];
const args = process.argv.slice(2);
const token = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--api");
const execute = args.includes("--execute");
const apiUrl = args.includes("--api") ? args[args.indexOf("--api") + 1] : null;
if (!token || !validToken(token)) {
  console.log("usage: node agent/run.mjs <TOKEN> [--execute] [--api <url>]");
  process.exit(2);
}
const accountId = process.env.TRUENAV_AGENT_ACCOUNT || null;
if (execute) {
  if (!accountId || !process.env.TRUENAV_AGENT_KEYFILE) throw new Error("--execute needs TRUENAV_AGENT_ACCOUNT and TRUENAV_AGENT_KEYFILE");
  if (SHARED.includes(accountId)) throw new Error(`${accountId} is a shared TrueNav account; the agent signs with its own account only`);
}
const chain = agentChain({ rpcUrl: RPC, query, accountId, keyFile: process.env.TRUENAV_AGENT_KEYFILE });
const status = await chain.provider.viewNodeStatus();
if (status.chain_id !== "testnet") throw new Error(`RPC chain_id is ${status.chain_id}, not testnet`);
console.log(`TrueNav demo agent, ${token}, ${execute ? `EXECUTE as ${accountId}` : "print only (views only, nothing signed)"}; receipts ${receipts}, query ${query}`);
const out = await runAgent({ chain, token, receipts, query, requestId: newRequestId(token, randomBytes(6).toString("hex")), execute, apiUrl });
console.log(JSON.stringify(out, null, 2));
console.log(summary(out));
if (!execute && out.entitlement && out.entitlement.would_buy) console.log("print only: nothing was sent. Re-run with --execute (agent's own account) after the owner's yes.");
