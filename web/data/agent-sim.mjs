// Browser port of the buyer agent's decision (agent/agent.mjs decide and v3EngineNotPinned) over a receipt described
// by its checked properties. Order is the agent's: missing, mismatch, failed head, engine pin, unknown score, red,
// hold, yellow, capped, stale, unattested v3, approve.
export const MAX_AGE_DAYS = 45;

/** r: null or { recordProblem?, failed?, failure_code?, version: "2"|"3", version_key?, engine_version_key?, engine_code_sha256?, score, band, caps, holds, as_of } */
export function decide(token, r, { nowMs = Date.now(), pins = new Set() } = {}) {
  if (!r) return { action: "decline", reason: "no_receipt", detail: `no receipt stored for ${token}` };
  if (r.recordProblem) return { action: "decline", reason: "receipt_mismatch", detail: r.recordProblem };
  if (r.failed) return { action: "decline", reason: "run_failed", detail: `run failed: ${r.failure_code || "failed"}` };
  if (r.version === "3") {
    const np = !pins.has(r.version_key) ? "the stored engine version_key is not a pinned build"
      : r.engine_version_key !== r.version_key ? "engine_version_key differs from the stored version_key"
      : r.engine_code_sha256 !== undefined && r.engine_code_sha256 !== r.version_key ? "engine_code_sha256 does not match the pinned build" : null;
    if (np) return { action: "decline", reason: "engine_hash", detail: np };
    if (r.score === null) return { action: "review", reason: "unknown", detail: "score unknown; no numeric score in this receipt" };
  }
  const caps = r.caps || [], holds = r.holds || [];
  if (r.band === "red" || r.score < 60) return { action: "decline", reason: "red", detail: `score ${r.score} red${caps.length ? `: ${caps.join(", ")}` : ""}` };
  if (holds.length) return { action: "review", reason: "hold", detail: `score ${r.score} ${r.band}, held: ${holds.join(", ")}` };
  if (r.band !== "green") return { action: "review", reason: "yellow", detail: `score ${r.score} ${r.band}${caps.length ? `: ${caps.join(", ")}` : ""}` };
  if (caps.length) return { action: "review", reason: "capped", detail: `score ${r.score} green but capped: ${caps.join(", ")}` };
  const ageDays = (nowMs - Date.parse(r.as_of)) / 86_400_000;
  if (!(ageDays <= MAX_AGE_DAYS)) return { action: "review", reason: "stale", detail: `receipt as of ${r.as_of} is ${Math.floor(ageDays)} days old` };
  if (r.version === "3") return { action: "review", reason: "unattested", detail: "unattested: no verified TEE attestation; a stored attestation_ref is not a pass" };
  return { action: "approve", reason: "green", detail: `score ${r.score} green, no caps, no holds` };
}

/** The variants the page offers, built around the pinned engine hash. */
export function variants(pin, nowIso) {
  const base = { version: "3", version_key: pin, engine_version_key: pin, engine_code_sha256: pin, score: 92, band: "green", caps: [], holds: [], as_of: nowIso };
  return [
    ["Pinned engine, green", base],
    ["Wrong engine version_key", { ...base, version_key: "0".repeat(64), engine_version_key: "0".repeat(64) }],
    ["engine_version_key differs from the stored key", { ...base, engine_version_key: "f".repeat(64) }],
    ["Receipt body does not match its hash", { ...base, recordProblem: "receipt_sha256_mismatch" }],
    ["Failed head", { ...base, failed: true, failure_code: "bank_feed_unavailable" }],
    ["Red", { ...base, score: 43, band: "red", caps: ["reported NAV above TrueRange"] }],
    ["Yellow", { ...base, score: 74, band: "yellow" }],
    ["Green with a cap", { ...base, caps: ["no_green_30d"] }],
    ["Stale (60 days)", { ...base, as_of: new Date(Date.parse(nowIso) - 60 * 86_400_000).toISOString() }],
    ["Version 2 receipt, green", { ...base, version: "2" }],
    ["No receipt", null],
  ];
}
