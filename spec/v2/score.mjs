// TrueNav cashflow-v2.0.0 score (spec/v2/SPEC.md sections 5.6 and 6), JS reference in integer math.
// Input: the run's aggregate metrics (the matcher produces them in build step 2). Output: parts in hundredths of
// a point, raw, score, band, and every red-flag cap with its reason. The Rust/WASM port must match byte for byte.
// Rounding (section 10): round half up on non-negative integers; ties go up.

export const METHOD = "cashflow-v2.0.0";
export const CAP_SCORE = 59;

/** round(a / b) half up, for integers a >= 0, b > 0. */
export function rhu(a, b) {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b <= 0) throw new Error(`rhu: bad operands ${a} / ${b}`);
  const q = Math.floor(a / b);
  return 2 * (a - q * b) >= b ? q + 1 : q;
}
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** Freshness windows by source cadence: [full until, zero at], in hours (section 5.6). */
export const CADENCE = { daily: [24, 168], monthly: [35 * 24, 65 * 24] };

/** Freshness of one source in bps: 10,000 inside the full window, linear to 0 at the zero point; 0 if carried forward. */
export function sourceFreshnessBps(src) {
  if (src.carried_forward) return 0;
  const w = CADENCE[src.cadence];
  if (!w) throw new Error(`unknown cadence ${src.cadence}`);
  const [full, zero] = w;
  if (!Number.isSafeInteger(src.age_hours) || src.age_hours < 0) throw new Error("age_hours must be a non-negative integer");
  if (src.age_hours <= full) return 10000;
  if (src.age_hours >= zero) return 0;
  return rhu(10000 * (zero - src.age_hours), zero - full);
}

/** The red-flag caps (owner review 7 Nov). Each cap holds the score at 59 or below and states why. */
export const CAPS = {
  self_reported_only: "red because no fresh bank-sourced evidence was available: self-reported only",
  yield_gap: "red because the reported yield is at least 3.00 percentage points above the cash yield",
  payout_exceeds_net_cash: "red because payouts exceed net cash from rent",
  distribution_funded_by_sponsor: "red because part of a payout was funded by a sponsor transfer, not by income",
  claimed_not_settled: "red because more than 2% of the cash the manager reports was never settled by the bank",
};

export function score(m) {
  if (m.kind !== "credit" && m.kind !== "rental") throw new Error("kind must be credit or rental");
  const fresh = m.sources.map((s) => ({ ...s, freshness_bps: sourceFreshnessBps(s) }));
  const required = fresh.filter((s) => s.required !== false);
  const runFresh = required.length ? Math.min(...required.map((s) => s.freshness_bps)) : 0;
  const cashMatch = clamp(m.cash_match_bps, 0, 10000);
  const late = clamp(m.late_share_bps, 0, 2000);
  const parts = {
    cash_match: rhu(4000 * cashMatch, 10000),
    gap:
      m.kind === "credit"
        ? rhu(2500 * (500 - clamp(m.yield_gap_bps, 0, 500)), 500)
        : rhu(2500 * clamp(m.rental_coverage_bps - 8000, 0, 2000), 2000),
    late: rhu(1500 * (2000 - late), 2000),
    freshness: rhu(2000 * runFresh, 10000),
  };
  const raw_x100 = parts.cash_match + parts.gap + parts.late + parts.freshness;
  const uncapped = rhu(raw_x100, 100);

  const caps = [];
  const freshTier3 = fresh.some((s) => s.tier === 3 && !s.carried_forward && s.freshness_bps > 0);
  if (!freshTier3) caps.push("self_reported_only");
  if (m.kind === "credit" && m.yield_gap_bps >= 300) caps.push("yield_gap");
  if (m.kind === "rental" && m.rental_coverage_bps < 10000) caps.push("payout_exceeds_net_cash");
  if ((m.exceptions.distribution_funded_by_sponsor || 0) > 0) caps.push("distribution_funded_by_sponsor");
  // more than 2% of claimed cash: claimed_not_settled / claimed > 200 / 10,000
  if (m.claimed_cash_cents > 0 && (m.exceptions.claimed_not_settled_cents || 0) * 10000 > 200 * m.claimed_cash_cents) caps.push("claimed_not_settled");

  const value = caps.length ? Math.min(uncapped, CAP_SCORE) : uncapped;
  const band = value >= 85 ? "green" : value >= 60 ? "yellow" : "red";
  return {
    method: METHOD,
    parts_x100: parts,
    raw_x100,
    uncapped_score: uncapped,
    score: value,
    band,
    caps: caps.map((code) => ({ code, reason: CAPS[code] })),
    run_freshness_bps: runFresh,
  };
}
