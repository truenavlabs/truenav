// NEAR adapter for the agent: views on the receipt and query contracts, and buy_query signed by the agent's own
// account. The key is read from a key file (account_id, private_key); only private_key is used and it is never
// printed or logged.
import { readFileSync } from "node:fs";
import { Account, JsonRpcProvider, KeyPair, actions, teraToGas } from "near-api-js";

export function agentChain({ rpcUrl, query, accountId, keyFile }) {
  const provider = new JsonRpcProvider({ url: rpcUrl });
  let account = null;
  let keyPair = null;
  const signer = () => {
    if (!account) {
      if (!accountId || !keyFile) throw new Error("buying needs the agent's account id and key file");
      const k = JSON.parse(readFileSync(keyFile, "utf8"));
      if (k.account_id !== accountId) throw new Error("agent key file is for another account (account_id must equal the agent account)");
      keyPair = KeyPair.fromString(k.private_key);
      account = new Account(accountId, provider, k.private_key);
    }
    return account;
  };
  return {
    provider,
    view: (contractId, method, args = {}) => provider.callFunction({ contractId, method, args, blockQuery: { finality: "final" } }),
    async nowMs() {
      const b = await provider.viewBlock({ finality: "final" });
      return Number(BigInt(b.header.timestamp_nanosec) / 1_000_000n);
    },
    signSpend(message) {
      signer();
      return Buffer.from(keyPair.sign(message).signature).toString("base64");
    },
    async buyQuery({ requestId, queryHash, kind, deposit }) {
      const tx = await signer().signAndSendTransaction({ receiverId: query, actions: [actions.functionCall("buy_query", { request_id: requestId, query_hash: queryHash, kind }, teraToGas("30"), deposit)], throwOnFailure: false, waitUntil: "FINAL" });
      if (!tx.status || tx.status.SuccessValue === undefined) throw new Error(`buy_query failed: ${JSON.stringify(tx.status && tx.status.Failure).slice(0, 200)}`);
      const e = JSON.parse(Buffer.from(tx.status.SuccessValue, "base64").toString());
      return { ...e, tx_hash: tx.transaction_outcome.id };
    },
  };
}
