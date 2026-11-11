// CLI for the demo agent. Testnet only (the RPC's chain id is checked). Without --execute it only reads (views) and
// prints the decision and the exact buy_query it would send; nothing is signed. With --execute it buys one report
// entitlement for the fee, signed by the agent's OWN account (never the shared TrueNav accounts).
//
//   node agent/run.mjs <TOKEN> [--execute] [--api <url>] [--master <account.testnet>]
//   env: TRUENAV_AGENT_ACCOUNT, TRUENAV_AGENT_KEYFILE (needed for --execute; key file account_id must match)
//        TRUENAV_MASTER (or --master; no default): the contracts are receipts.<master> and query.<master>
import { randomBytes } from "node:crypto";
import { agentChain } from "./chain.mjs";
import { runAgent, summary, newRequestId } from "./agent.mjs";
import { parseRunArgs, UsageError, USAGE } from "./run-args.mjs";

const RPC = "https://rpc.testnet.near.org";
let token, execute, apiUrl, MASTER;
try {
  ({ token, execute, apiUrl, master: MASTER } = parseRunArgs(process.argv.slice(2)));
} catch (e) {
  if (!(e instanceof UsageError)) throw e;
  if (e.usage) console.log(USAGE);
  else console.error(`${e.message}\n${USAGE}`);
  process.exit(2);
}
const receipts = `receipts.${MASTER}`;
const query = `query.${MASTER}`;
const SHARED = [MASTER, receipts, query, `runner.${MASTER}`, `api.${MASTER}`];
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
