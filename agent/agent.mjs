// TrueNav demo agent (synthetic tokens only): reads a token's free public score from the receipt contract, buys one
// "report" entitlement on the query contract for the fee, and acts on the score with a fixed rule. It never holds or
// moves anything else: the only value it sends is the entitlement fee.
//
// The rule (decide):
//   no receipt on chain                 decline  (no evidence; nothing is bought)
//   receipt bytes do not match the hash decline  (receipt_mismatch; nothing is bought)
//   red (score below 60)                decline  (the caps are the reasons)
//   any hold                            review
//   yellow (60 to 84)                   review
//   green with any cap                  review   (the caps are the reasons)
//   as_of older than 45 days            review   (stale)
//   green (85 and up), no caps, no hold approve
//   v3 with no matched attestation_ref       review (unattested; a matching engine hash alone is not a pass)
//   v3 engine hash other than the pinned key decline
import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import {decodeReceipt, publicV3, canonical, spendMessage} from "../api/receipt.mjs";

export const MAX_AGE_DAYS = 45;
export const DEFAULT_MAX_FEE = 10n ** 22n; // 0.01 NEAR: the agent refuses to pay more
export const queryHash = (kind, token) => createHash("sha256").update(`${kind}|${token}`).digest("hex");
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** Check a stored receipt record against its own bytes (score, band, method, caps, holds and as_of must all match
 * the receipt they index); returns null when consistent, else a short code. */
export function verifyRecord(token, r) {
  if(r?.error) return r.error === 'v3_receipt_corrupt' ? r.error : 'receipt_invalid';
  if(r?.receipt_version && !['2','3'].includes(r.receipt_version)) return 'receipt_version_unsupported';
  if(r?.receipt_version === '3' || r?.method?.startsWith('truenav-v3.')) {
    const raw = typeof r.receipt === 'string' ? r.receipt : '';
    if (!raw || sha256(raw) !== (r.public_sha256 || r.receipt_sha256)) return 'receipt_sha256_mismatch';
    let decoded;
    try { decoded=decodeReceipt(r); } catch(error) { return error.code ?? "receipt_invalid"; }
    if(decoded.version!=='3') return 'receipt_version_mismatch';
    const rec=decoded.receipt;
    if (rec.head_status === "failed") return null;
    if (rec.private_commitment !== undefined && !/^[0-9a-f]{64}$/.test(rec.private_commitment)) return 'private_commitment_invalid';
    if (rec.private_salt !== undefined) return 'private_salt_published';
    if(rec.token_id!==token || decoded.record.token_id!==token) return 'receipt_token_mismatch';
    if(!(rec.score===decoded.record.score || (rec.score===null && decoded.record.score===0)) || rec.band!==decoded.record.band || rec.method_version!==decoded.record.method || rec.engine_version_key!==decoded.record.version_key || rec.seq!==String(decoded.record.seq) || rec.valuation_time!==decoded.record.as_of || canonical(rec.caps)!==canonical(decoded.record.caps) || canonical(rec.holds)!==canonical(decoded.record.holds)) return 'receipt_index_mismatch';
    return null;
  }
  if (sha256(r.receipt) !== (r.public_sha256 || r.receipt_sha256)) return "receipt_sha256_mismatch";
  let recHead;
  try { recHead = JSON.parse(r.receipt); } catch { return "receipt_not_json"; }
  if (recHead.head_status === "failed") return null;
  if (recHead.private_commitment !== undefined && !/^[0-9a-f]{64}$/.test(recHead.private_commitment)) return "private_commitment_invalid";
  if (recHead.private_salt !== undefined) return "private_salt_published";
  let rec;
  try {
    rec = JSON.parse(r.receipt);
  } catch {
    return "receipt_not_json";
  }
  if (rec.token_id !== token || r.token_id !== token) return "receipt_token_mismatch";
  if (rec.score !== r.score || rec.band !== r.band || rec.method !== r.method) return "receipt_index_mismatch";
  const codes = (xs) => (Array.isArray(xs) ? JSON.stringify(xs.map((x) => (x && typeof x === "object" ? x.code : x))) : null);
  if (!Array.isArray(r.caps) || codes(rec.caps) !== codes(r.caps)) return "receipt_caps_mismatch";
  if (!Array.isArray(r.holds) || codes(rec.holds) !== codes(r.holds)) return "receipt_holds_mismatch";
  if (rec.as_of !== r.as_of) return "receipt_as_of_mismatch";
  return null;
}

/** The decision for one token from its latest stored receipt (or null). Pure: no chain access. */
export function decide(token, r, { nowMs = Date.now(), maxAgeDays = MAX_AGE_DAYS } = {}) {
  if (!r) return { action: "decline", reason: "no_receipt", detail: `no receipt stored for ${token}` };
  const bad = verifyRecord(token, r);
  if (bad) return { action: "decline", reason: "receipt_mismatch", detail: bad };
  const decoded=decodeReceipt(r);
  if (decoded.receipt?.head_status === "failed") return { action: "decline", reason: "run_failed", detail: `run failed: ${decoded.receipt.failure_code || "failed"}` };
  r=decoded.record;
  if(decoded.version==='3' && decoded.receipt.score===null) return {action:'review',reason:'unknown',detail:'score unknown; no numeric score in this receipt'};
  if (r.band === "red" || r.score < 60) return { action: "decline", reason: "red", detail: `score ${r.score} red${r.caps.length ? `: ${r.caps.join(", ")}` : ""}` };
  if (r.holds.length) return { action: "review", reason: "hold", detail: `score ${r.score} ${r.band}, held: ${r.holds.join(", ")}` };
  if (r.band !== "green") return { action: "review", reason: "yellow", detail: `score ${r.score} ${r.band}${r.caps.length ? `: ${r.caps.join(", ")}` : ""}` };
  if (r.caps.length) return { action: "review", reason: "capped", detail: `score ${r.score} green but capped: ${r.caps.join(", ")}` };
  const ageDays = (nowMs - Date.parse(r.as_of)) / 86_400_000;
  if (!(ageDays <= maxAgeDays)) return { action: "review", reason: "stale", detail: `receipt as of ${r.as_of} is ${Math.floor(ageDays)} days old` };
  if (decoded.version === "3") {
    const pinned = decoded.receipt.engine_code_sha256;
    if (pinned && pinned !== r.version_key) return { action: "decline", reason: "engine_hash", detail: "engine hash does not match the pinned build" };
    return { action: "review", reason: "unattested", detail: "unattested: no verified TEE attestation; a stored attestation_ref is not a pass" };
  }
  return { action: "approve", reason: "green", detail: `score ${r.score} green, no caps, no holds` };
}

export const newRequestId = (token, rand) => `agent-${token}-${rand}`.slice(0, 64);

/**
 * Run the agent once for a token. `chain` provides: view(contract, method, args), buyQuery({ requestId, queryHash,
 * kind, deposit }) -> entitlement, and optionally nowMs(). With `apiUrl`, the entitlement is spent on GET
 * /fund/<token>/report and the served receipt is checked against the free score's hash. Nothing is bought unless
 * `execute: true` is passed: by default the result only says what would be paid.
 */
export async function runAgent({ chain, token, receipts, query, requestId, execute = false, apiUrl = null, maxFee = DEFAULT_MAX_FEE, nowMs }) {
  const now = nowMs ?? (chain.nowMs ? await chain.nowMs() : Date.now());
  // 1. the free public score
  let latest = await chain.view(receipts, "get_latest", { token_id: token });
  const tokenInfo = await chain.view(receipts, "get_token", { token_id: token });
  const decision = decide(token, latest, { nowMs: now });
  if(latest && decision.reason!=="receipt_mismatch") { const decoded=decodeReceipt(latest); latest=decoded.version==='3'?{...decoded.record,score:decoded.receipt.score}:decoded.record; }
  const out = {
    token_id: token,
    registered: !!tokenInfo,
    decision,
    receipt: latest && !latest.error ? { contract: receipts, seq: latest.seq, score: latest.score, band: latest.band, caps: latest.caps, holds: latest.holds, period: latest.period, as_of: latest.as_of, method: latest.method, version_key: latest.version_key, receipt_sha256: latest.receipt_sha256, stored_block: latest.block_height } : null,
    entitlement: null,
  };
  // nothing to buy when there is no (valid) receipt
  if (!latest || decision.reason === "receipt_mismatch") {
    out.entitlement = { bought: false, why: decision.reason };
    return out;
  }
  // 2. one report entitlement, for exactly the fee, never above maxFee
  const cfg = await chain.view(query, "get_config");
  const fee = BigInt(cfg.fee);
  if (cfg.paused) throw new Error("query contract is paused");
  if (fee > maxFee) throw new Error(`fee ${fee} yoctoNEAR is above the agent's maximum ${maxFee}`);
  const qh = queryHash("report", token);
  if (!execute) {
    out.entitlement = { bought: false, why: "print_only", would_buy: { contract: query, method: "buy_query", args: { request_id: requestId, query_hash: qh, kind: "report" }, deposit: fee.toString() } };
    return out;
  }
  const e = await chain.buyQuery({ requestId, queryHash: qh, kind: "report", deposit: fee });
  if (e.request_id !== requestId || e.query_hash !== qh || e.kind !== "report" || BigInt(e.paid) !== fee) throw new Error("entitlement does not match the purchase");
  out.entitlement = { bought: true, contract: query, request_id: e.request_id, buyer: e.buyer, paid: e.paid, expires_ns: e.expires_ns, uses_left: e.uses_left, tx_hash: e.tx_hash || null };
  // 3. optionally spend it on the full report through the API, and check it is the receipt the score came from
  if (apiUrl) {
    const nowMs = chain.nowMs ? await chain.nowMs() : Date.now();
    const exp = String(nowMs + 60_000);
    const nonce = randomBytes(16).toString("hex");
    const headers = { "x-truenav-entitlement": requestId, "x-truenav-buyer": e.buyer, "x-truenav-buyer-nonce": nonce, "x-truenav-buyer-exp": exp };
    if (typeof chain.signSpend === "function") headers["x-truenav-buyer-sig"] = await chain.signSpend(spendMessage({ audience: query, id: requestId, kind: "report", token, nonce, exp }));
    const res = await fetch(`${apiUrl}/fund/${encodeURIComponent(token)}/report`, { headers });
    const body = await res.json();
    if (res.status !== 200) throw new Error(`report refused (${res.status}): ${body.error}`);
    if (body.receipt_sha256 !== latest.receipt_sha256 || body.seq !== latest.seq) throw new Error("the report is not the receipt the score came from");
    out.entitlement.uses_left = body.entitlement.uses_left;
    if(body.receipt?.error === 'v3_receipt_corrupt') throw new Error('v3_receipt_corrupt');
    if(latest.method?.startsWith('truenav-v3.')) {
      const text = JSON.stringify(body.receipt ?? {});
      if (text.includes("uncapped_score") || text.includes("outstanding_cents") || text.includes("\"metrics\"")) throw new Error("private_field");
      out.report={status:200,...publicV3(body.receipt), receipt_sha256: latest.receipt_sha256, attestation:"unattested"};
    }
    else out.report = { status: 200, seq: body.seq, receipt_sha256: body.receipt_sha256, score: body.receipt.score, band: body.receipt.band, caps: body.receipt.caps, holds: body.receipt.holds };
  }
  return out;
}

/** One line a person reads: the decision and the receipt reference. */
export function summary(out) {
  const r = out.receipt;
  const ref = r ? `${r.contract} ${out.token_id} seq ${r.seq} receipt_sha256 ${r.receipt_sha256.slice(0, 16)}... (${r.method}, build ${r.version_key.slice(0, 12)}...)` : `${out.token_id}: no receipt`;
  const ent = out.entitlement && out.entitlement.bought ? `; entitlement ${out.entitlement.request_id} on ${out.entitlement.contract}, paid ${out.entitlement.paid} yoctoNEAR` : out.entitlement && out.entitlement.would_buy ? `; would pay ${out.entitlement.would_buy.deposit} yoctoNEAR for buy_query` : "; nothing bought";
  return `${out.decision.action.toUpperCase()} ${out.token_id}: ${out.decision.detail}. Receipt ${ref}${ent}`;
}
