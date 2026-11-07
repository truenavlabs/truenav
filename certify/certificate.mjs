// Engine result -> score certificate -> EIP-191 signature, matching contract/src/lib.rs exactly.
// Money is integer cents and raw is hundredths, so the signed message has no floating point.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

export const CERT_DOMAIN = "truenav-cert-v1";

const cents = (x) => String(typeof x === "number" && Number.isFinite(x) ? Math.max(0, Math.round(x * 100)) : 0); // U128 on the contract: a decimal string in JSON

/**
 * Build the contract Certificate from one engine result.
 * @param {object} r        result of scoreFund / scorePortfolio
 * @param {object} binding  { fund_account, manager_id } as registered on the contract
 * @param {object} meta     { nowMs, engineCommit }
 */
export function toCertificate(r, binding, meta) {
  const scored = r.status === "scored";
  const dataAsof = typeof r.dataAgeHours === "number" ? Math.round(meta.nowMs - r.dataAgeHours * 3600 * 1000) : 0;
  return {
    fund_id: r.fundId,
    fund_account: binding.fund_account,
    manager_id: binding.manager_id,
    status: r.status,
    score: scored ? r.score : null,
    band: scored ? r.band : "",
    raw_x100: Number.isFinite(r.raw) ? Math.round(r.raw * 100) : 0,
    true_val_cents: cents(r.trueVal),
    true_range_cents: cents(r.trueRange),
    policy_nav_cents: cents(r.policyNav),
    headline_cents: cents(r.headline),
    blocked_attempts: r.penaltyDetail ? r.penaltyDetail.attemptsCounted : 0,
    data_asof_ms: Math.max(0, Math.min(dataAsof, meta.nowMs)),
    signed_at_ms: meta.nowMs,
    engine_commit: meta.engineCommit,
  };
}

/** Same field order as canonical_message in the contract. */
export function canonicalMessage(contractId, c) {
  return [
    CERT_DOMAIN, contractId, c.fund_id, c.fund_account, c.manager_id, c.status,
    c.score === null || c.score === undefined ? "" : String(c.score), c.band,
    String(c.raw_x100), String(c.true_val_cents), String(c.true_range_cents), String(c.policy_nav_cents),
    String(c.headline_cents), String(c.blocked_attempts), String(c.data_asof_ms), String(c.signed_at_ms), c.engine_commit,
  ].join("|");
}

const enc = new TextEncoder();
const hex = (b) => Buffer.from(b).toString("hex");

/** keccak256("\x19Ethereum Signed Message:\n" + len + message). len is the UTF-8 byte length. */
export function eip191Digest(message) {
  const body = enc.encode(message);
  const prefix = enc.encode(`\x19Ethereum Signed Message:\n${body.length}`);
  const all = new Uint8Array(prefix.length + body.length);
  all.set(prefix, 0);
  all.set(body, prefix.length);
  return keccak_256(all);
}

export function addressOf(secretKey) {
  const pub = secp256k1.getPublicKey(secretKey, false); // 65 bytes, 0x04 prefix
  return `0x${hex(keccak_256(pub.slice(1)).slice(12))}`;
}

/** EIP-191 signature of `message` as 65-byte r || s || v (v = 27 or 28) in 0x hex, which the contract accepts. */
export function signEip191(message, secretKey) {
  const rec = secp256k1.sign(eip191Digest(message), secretKey, { prehash: false, format: "recovered" }); // recovery byte first
  const out = new Uint8Array(65);
  out.set(rec.slice(1), 0);
  out[64] = rec[0] + 27;
  return `0x${hex(out)}`;
}

export function signCertificate(contractId, cert, secretKey) {
  return signEip191(canonicalMessage(contractId, cert), secretKey);
}

export function newSecretKey() {
  return secp256k1.utils.randomSecretKey();
}
