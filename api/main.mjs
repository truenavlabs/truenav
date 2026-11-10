// Start the API against a NEAR RPC. Every setting comes from the environment; nothing secret is printed.
//   TRUENAV_RPC  TRUENAV_RECEIPTS  TRUENAV_QUERY  TRUENAV_REDEEMER  TRUENAV_REDEEMER_KEY_FILE  [PORT]  [TRUENAV_FEE]
import { createServer } from "./server.mjs";
import { nearChain } from "./chain.mjs";
import { initSpendStore } from "./spend-store.mjs";

const need = (k) => process.env[k] || (console.error(`missing ${k}`), process.exit(2));
const spendStore = need("TRUENAV_SPEND_STORE");
try { await initSpendStore(spendStore); }
catch (error) { console.error(error.message); process.exit(2); }
const rpcUrl = need("TRUENAV_RPC");
if (!/testnet|127\.0\.0\.1|localhost/.test(rpcUrl)) {
  console.error("testnet or a local sandbox only");
  process.exit(2);
}
const receipts = need("TRUENAV_RECEIPTS");
const query = need("TRUENAV_QUERY");
const chain = nearChain({ rpcUrl, query, redeemerId: need("TRUENAV_REDEEMER"), keyFile: need("TRUENAV_REDEEMER_KEY_FILE") });
const port = Number(process.env.PORT || 8787);
const proxyHops = Number(process.env.TRUENAV_PROXY_HOPS || 1);
createServer({ chain, receipts, query, fee: process.env.TRUENAV_FEE || "10000000000000000000000", spendStore, trustProxy: process.env.TRUENAV_TRUST_PROXY === "1", proxyHops: Number.isInteger(proxyHops) && proxyHops > 0 ? proxyHops : 1 }).listen(port, () => console.log(`TrueNav API on :${port} (receipts ${receipts}, query ${query})`));
