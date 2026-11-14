// Build the guest JSON for a v3 run. The chain payload is the public envelope only, so it validates
// against the frozen v3.0.1 schema. The commitment, the salt and the private object stay off chain
// (buyerDeliveries). receipt_sha256 is left for the contract.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonical } from "../../api/receipt.mjs";

export const buyerDeliveries = [];

export const V3_PIN = "098f5d86a94288d13fac1ca66b8aba9c20a2dc1b3585a64ef91d5bba5aa68788";
const V3_CAPS = new Set(["self_reported_only", "yield_gap", "distribution_funded_by_sponsor", "claimed_not_settled", "collection_shortfall", "pledge_conflict"]);

export function exampleEnvelope() {
  return JSON.parse(readFileSync(new URL("../../schema/vectors/engine-v3-derived.json", import.meta.url), "utf8")).vectors[0].envelope;
}

export function guestFromEngine(example, engineText, context) {
  const e = structuredClone(example);
  for (const key of ["network", "receipts_contract", "token_id", "fund_id", "fund_account", "period_start", "period_end", "seq", "prev_receipt_sha256", "supersedes_seq", "correction_reason_code", "request_id", "request_nonce", "engine_version_key", "engine_code_sha256"]) {
    if (context && Object.hasOwn(context, key)) e[key] = context[key];
  }
  delete e.receipt_sha256;
  delete e.issued_at;
  delete e.attestation_ref;
  let eng = null;
  try { eng = JSON.parse(engineText); } catch { eng = null; }
  const priv = {};
  if (eng && typeof eng === "object" && !Array.isArray(eng)) {
    if (typeof eng.score === "number") e.score = eng.score;
    if (typeof eng.band === "string") e.band = eng.band;
    const caps = (Array.isArray(eng.caps) ? eng.caps : []).map((c) => (c && c.code) || c).filter((c) => typeof c === "string");
    e.caps = caps.filter((c) => V3_CAPS.has(c));
    e.holds = [];
    const hidden = caps.filter((c) => !V3_CAPS.has(c));
    if (hidden.length) priv.caps_not_public = hidden;
    for (const key of ["metrics", "parts_x100", "raw_x100", "uncapped_score", "passport", "outstanding_cents", "late_share_bps", "payout_exceeds_net_cash"]) {
      if (eng[key] !== undefined) priv[key] = eng[key];
    }
  }
  const salt = randomBytes(32).toString("hex");
  const commitment = createHash("sha256").update(`truenav-private-v1|${salt}|${canonical(priv)}`).digest("hex");
  buyerDeliveries.push({ token_id: e.token_id, commitment, salt, private_report: priv });
  return JSON.stringify(e);
}

export { canonical };
