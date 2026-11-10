// Canonical pledge ticket text. The registry contract builds the same string in pledge_message.
// A simulated servicer signs this with its registered secp256k1 key. A fingerprint module that is asked
// for a ticket composes this same text itself and signs it with its manifest key. Neither path signs
// caller-supplied raw bytes.

export const PLEDGE_DOMAIN = "truenav-pledge-v1";
export const PLEDGE_TTL_MS = 24 * 3600 * 1000;

/** Same suffix rule as network_of in the registry contract. */
export function networkOf(account) {
  const suffix = String(account).split(".").pop() || "";
  if (suffix === "testnet") return "testnet";
  if (suffix === "near") return "mainnet";
  return suffix;
}

export function pledgeMessage(contractId, network, loanHash, fundAccount, assetType, nonce, expiryMs) {
  return [PLEDGE_DOMAIN, contractId, network, loanHash, fundAccount, assetType, nonce, String(expiryMs)].join("|");
}

/** Fields a caller may pass to the fingerprint module. The module computes loan_hash and the signed text. */
export function ticketInput(contractId, fundAccount, expiryMs, pledgeNonce) {
  return {
    contract_id: contractId,
    network: networkOf(contractId),
    fund_account: fundAccount,
    expiry_ms: expiryMs,
    pledge_nonce: pledgeNonce,
  };
}
