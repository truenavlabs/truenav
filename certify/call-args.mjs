// Function-call args are published on chain verbatim, even when the call fails. Only plain JSON values may go
// in: a near-api-js Account (it carries its signer key and a BigInt nonce cache) or any BigInt must be refused
// here, before JSON.stringify, so a wrong argument never reaches a transaction.
import { signEip191 } from "./certificate.mjs";
import { networkOf, pledgeMessage } from "../tee/pledge-ticket.mjs";

function isPlainObject(v) {
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

/** Returns args unchanged if every value is plain JSON; throws with the offending path otherwise. */
export function plainCallArgs(args, path = "args") {
  const t = typeof args;
  if (args === null || t === "string" || t === "boolean" || t === "undefined") return args;
  if (t === "number") {
    if (!Number.isFinite(args)) throw new TypeError(`${path} is not a finite number`);
    return args;
  }
  if (t === "bigint") throw new TypeError(`${path} is a BigInt; pass NEAR u64/u128 values as strings`);
  if (t !== "object") throw new TypeError(`${path} is a ${t}, not a JSON value`);
  if (Array.isArray(args)) {
    args.forEach((v, i) => plainCallArgs(v, `${path}[${i}]`));
    return args;
  }
  if (!isPlainObject(args)) throw new TypeError(`${path} is a ${args.constructor?.name || "non-plain"} object, not plain JSON`);
  for (const [k, v] of Object.entries(args)) plainCallArgs(v, `${path}.${k}`);
  return args;
}

/** pledge_loan args. fundAccountId is the fund's account id string, never an Account object. */
export function pledgeArgs({ contractId, fundAccountId, loanHash, assetType, nonce, expiryMs, secretKey }) {
  if (typeof fundAccountId !== "string" || !fundAccountId) throw new TypeError("fundAccountId must be an account id string");
  const message = pledgeMessage(contractId, networkOf(contractId), loanHash, fundAccountId, assetType, nonce, expiryMs);
  return plainCallArgs({ loan_hash: loanHash, asset_type: assetType, fund_account: fundAccountId, nonce, expiry_ms: expiryMs, servicer_signature: signEip191(message, secretKey), ticket_signature: null });
}
