// Build the guest JSON for a v3 run: a schema envelope plus a private object the contract commits
// and does not store. receipt_sha256 is left for the contract to seal.
import { readFileSync } from "node:fs";
import { canonical } from "../../api/receipt.mjs";

export const V3_PIN = "0ffb3e314f2a3881bd28ab70cb9ba01a6f9b6f6fe41af8ef81b0455ce9ca8d38";
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
    for (const key of ["metrics", "parts_x100", "raw_x100", "uncapped_score", "passport"]) {
      if (eng[key] !== undefined) priv[key] = eng[key];
    }
  }
  e.private = priv;
  return JSON.stringify(e);
}

export { canonical };
