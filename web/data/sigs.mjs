// Signature recovery in the browser (and Node), with @noble/curves and @noble/hashes. Same digest and recovery as
// contract/src/lib.rs: eip191_digest (keccak256 of "\x19Ethereum Signed Message:\n" + byte length + message) and
// recover_address (65-byte r || s || v, v in 0, 1, 27 or 28, address = last 20 bytes of keccak256(pubkey)).
//   TEE verdicts: message `${model}:${request_sha256}:${sha256(response_body)}` (tee/underwrite.mjs, lib.rs submit_verdict).
//   Certificates: canonical_message (lib.rs 401), pipe-joined fields starting with "truenav-cert-v1" and the contract id.
import { eip191Recover, sha256Hex } from "../verifier/eip191.mjs";
import { decodeTx, loadTx } from "./tx.mjs";

export const CERT_DOMAIN = "truenav-cert-v1";

/** Same field order as canonical_message in contract/src/lib.rs. */
export function canonicalCertMessage(contractId, c) {
  return [
    CERT_DOMAIN, contractId, c.fund_id, c.fund_account, c.manager_id, c.status,
    c.score === null || c.score === undefined ? "" : String(c.score), c.band,
    String(c.raw_x100), String(c.true_val_cents), String(c.true_range_cents), String(c.policy_nav_cents),
    String(c.headline_cents), String(c.blocked_attempts), String(c.data_asof_ms), String(c.signed_at_ms), c.engine_commit,
  ].join("|");
}

/** Message the enclave signs for one verdict. */
export const verdictMessage = (model, onchain) => `${model}:${onchain.request_sha256}:${sha256Hex(onchain.response_body)}`;

/** Recover the signer of a recorded verdict; { address } or { error }. Never throws. */
export function recoverVerdict(model, onchain) {
  try { return { address: eip191Recover(verdictMessage(model, onchain), onchain.signature) }; } catch (e) { return { address: null, error: String(e && e.message ? e.message : e) }; }
}

/** Every record in a verdicts file: recovered signer and whether it equals `teeSigner`. */
export function recoverAllVerdicts(file, teeSigner) {
  const want = String(teeSigner || "").toLowerCase();
  const rows = (file.results || []).filter((r) => r && r.onchain).map((r) => {
    const rec = recoverVerdict(file.model, r.onchain);
    return { loan_hash: r.loan_hash, tampered: !!r.tampered, recovered: rec.address, error: rec.error ?? null, ok: rec.address === want };
  });
  return { signer: want, rows, total: rows.length, ok: rows.filter((r) => r.ok).length };
}

/** Recover a certificate signature from a decoded submit_certificate transaction. */
export function recoverCertificateTx(d) {
  const cert = d && d.args && d.args.certificate;
  if (!cert || typeof d.args.signature !== "string") return { address: null, error: "not a submit_certificate call" };
  const message = canonicalCertMessage(d.receiver, cert);
  try { return { address: eip191Recover(message, d.args.signature), message, certificate: cert }; } catch (e) { return { address: null, error: String(e && e.message ? e.message : e), message, certificate: cert }; }
}

const CERT_FIELDS = ["fund_id", "fund_account", "manager_id", "status", "score", "band", "raw_x100", "true_val_cents", "true_range_cents", "policy_nav_cents", "headline_cents", "blocked_attempts", "data_asof_ms", "signed_at_ms", "engine_commit"];
/** True when the certificate in a transaction is field for field the one the contract stores. */
export const sameCertificate = (a, b) => !!a && !!b && CERT_FIELDS.every((k) => String(a[k] ?? "") === String(b[k] ?? ""));

/** Accepted certificate transactions on the live registry (signatures are only in the transaction arguments). */
export const CERT_TXS = Object.freeze([
  { hash: "5tFsYFpqbriyUrzicrrSyPqbpEut32DMSR75hBKj4qKx", sender: "tnlab-368aa2.testnet", fund_id: "harbor-credit-fund" },
  { hash: "9vW8N6fWHWHmnwVwECTdwzYnHgxRswuEGSbZLX6ED9bn", sender: "tnlab-368aa2.testnet", fund_id: "meridian-yield-fund" },
]);

/**
 * Check each accepted certificate: the signature in its transaction recovers to a registered certificate signer,
 * and the signed certificate equals the latest one the contract stores. `txs` maps hash to a decoded tx (recorded),
 * or pass `live: true` to read them now from RPC.
 * @param {{ signers?: string[], latest?: Record<string, any>, txs?: Record<string, any> | null, live?: boolean, url?: string, fetchImpl?: any, flip?: boolean }} [opts]
 */
export async function checkCertificates({ signers, latest, txs = null, live = false, url, fetchImpl, flip = false } = {}) {
  const want = (signers || []).map((s) => String(s).toLowerCase());
  const out = [];
  for (const t of CERT_TXS) {
    let d = txs && txs[t.hash] ? txs[t.hash] : null;
    if (!d && live) d = await loadTx(t.hash, t.sender, { url, fetchImpl });
    if (!d) { out.push({ ...t, ok: false, error: "transaction not available" }); continue; }
    if (flip) d = { ...d, args: { ...d.args, signature: flipByte(d.args.signature) } };
    const rec = recoverCertificateTx(d);
    const stored = latest && latest[t.fund_id] ? latest[t.fund_id].certificate : null;
    const same = sameCertificate(rec.certificate, stored);
    out.push({ ...t, recovered: rec.address, error: rec.error ?? null, registered: !!rec.address && want.includes(rec.address), sameAsStored: same, ok: !!rec.address && want.includes(rec.address) && same, txOk: d.ok });
  }
  return out;
}

/** Flip one hex digit of the s half of a signature (a tamper test). */
export function flipByte(sig) {
  const s = String(sig);
  const i = s.startsWith("0x") ? 2 + 70 : 70;
  return s.slice(0, i) + (s[i] === "0" ? "1" : "0") + s.slice(i + 1);
}

/** Decode the recorded accepted-certificate transactions file. */
export const decodeRecordedTxs = (file) => Object.fromEntries(Object.entries(file.txs || {}).map(([h, r]) => [h, decodeTx(r)]));
