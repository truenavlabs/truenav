// NEAR client for the API: views on the receipt and query contracts, and `redeem` signed by the API's redeemer
// account. The key is read from a key file (account_id, private_key) whose path is given at start; it is never
// logged. A function-call access key limited to `redeem` on the query contract is enough (redeem takes no deposit).
import { readFileSync } from "node:fs";
import { Account, JsonRpcProvider, actions, teraToGas } from "near-api-js";

export function nearChain({ rpcUrl, query, redeemerId, keyFile }) {
  const provider = new JsonRpcProvider({ url: rpcUrl });
  let account = null;
  const signer = () => {
    if (!account) {
      const k = JSON.parse(readFileSync(keyFile, "utf8"));
      if (k.account_id && k.account_id !== redeemerId) throw new Error("key file is for another account");
      account = new Account(redeemerId, provider, k.private_key);
    }
    return account;
  };
  return {
    view: (contractId, method, args = {}) => provider.callFunction({ contractId, method, args, blockQuery: { finality: "final" } }),
    async nowNs() {
      const b = await provider.viewBlock({ finality: "final" });
      return BigInt(b.header.timestamp_nanosec);
    },
    async redeem(requestId, queryHash) {
      const tx = await signer().signAndSendTransaction({ receiverId: query, actions: [actions.functionCall("redeem", { request_id: requestId, query_hash: queryHash }, teraToGas("30"), 0n)], throwOnFailure: false, waitUntil: "FINAL" });
      if (!tx.status || tx.status.SuccessValue === undefined) throw new Error(JSON.stringify(tx.status && tx.status.Failure).slice(0, 200));
      return JSON.parse(Buffer.from(tx.status.SuccessValue, "base64").toString());
    },
  };
}
