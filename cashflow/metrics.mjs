// TrueNav cashflow-v2.0.0 metrics (spec/v2/SPEC.md section 5) from a match result (cashflow/match.mjs).
// Integer cents and bps, round half up (spec section 10). Produces the aggregates the score needs
// (spec/v2/score.mjs) plus the public metrics block of the receipt. Cohorts under 5 units are suppressed in the
// public block; the score only ever sees totals.
import { rhu } from "../spec/v2/score.mjs";
import { days } from "./match.mjs";

export const MIN_COHORT = 5;
export const COHORTS = [
  ["current", 0, 29],
  ["30", 30, 59],
  ["60", 60, 89],
  ["90+", 90, Infinity],
];
const cohortOf = (dpd) => COHORTS.find(([, lo, hi]) => dpd >= lo && dpd <= hi)[0];
const ratioBps = (a, b, ifZero) => (b === 0 ? ifZero : rhu(10000 * a, b));
const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);

/**
 * kind: "credit" | "rental". m: match() output. issuer: the issuer's public claims for the period.
 * units: { unit_ref: { principal_outstanding_cents } } for credit (from the servicer tape); not needed for rental.
 * asOf: ISO date of the run. period: "YYYY-MM". daysInPeriod: integer.
 */
export function metrics({ kind, m, issuer, units = {}, asOf, period, daysInPeriod }) {
  const now = days(asOf);
  const inPeriod = m.due.filter((d) => d.period === period);
  const settledCapped = (d) => Math.min(d.settled_cents, d.amount_due_cents);
  const cash_received_cents = sum(inPeriod, settledCapped);
  // cash match: of the claims the manager reports as paid in this period (by paid_date), how much the bank settled.
  // Reversed claims are already gone; claims linked to no due item are not claimed cash.
  const periodClaims = m.claims.filter((c) => c.linked_due && c.paid_date.slice(0, 7) === period && c.outcome !== "reversed_by_manager");
  const claimed_cash_cents = sum(periodClaims, (c) => c.amount_cents);
  const settled_claims_cents = sum(periodClaims.filter((c) => c.settled_by), (c) => c.amount_cents);
  const claimed_not_settled_cents = sum(periodClaims.filter((c) => c.outcome === "claimed_not_settled"), (c) => c.amount_cents);
  const cash_match_bps = Math.min(10000, ratioBps(settled_claims_cents, claimed_cash_cents, 10000));

  // late-payment cohorts per unit: days from the oldest due item not paid in full (by bank cash) to asOf
  const perUnit = new Map();
  for (const d of m.due) {
    if (d.status === "paid_full" || days(d.due_date) > now) continue;
    const dpd = now - days(d.due_date);
    const u = perUnit.get(d.unit_ref) || { dpd: -1, past_due_cents: 0 };
    u.dpd = Math.max(u.dpd, dpd);
    u.past_due_cents += d.amount_due_cents - settledCapped(d);
    perUnit.set(d.unit_ref, u);
  }
  const allUnits = new Set([...m.due.map((d) => d.unit_ref), ...Object.keys(units)]);
  const cohorts = Object.fromEntries(COHORTS.map(([c]) => [c, { units: 0, outstanding_cents: 0 }]));
  for (const u of allUnits) {
    const p = perUnit.get(u);
    const c = p ? cohortOf(p.dpd) : "current";
    const outstanding = kind === "credit" ? (units[u] ? units[u].principal_outstanding_cents : 0) : p ? p.past_due_cents : 0;
    cohorts[c].units++;
    cohorts[c].outstanding_cents += outstanding;
  }
  const late60 = cohorts["60"].outstanding_cents + cohorts["90+"].outstanding_cents;

  const flags = [];
  const out = { kind, period, as_of: asOf, cash_received_cents, claimed_cash_cents, cash_match_bps, cohorts, exceptions: { ...m.exceptions, claimed_not_settled_cents }, flags };

  if (kind === "credit") {
    const cash_interest_cents = sum(inPeriod.filter((d) => d.component === "interest"), settledCapped);
    const principal = issuer.principal_outstanding_cents;
    const cash_yield_bps = principal > 0 ? rhu(cash_interest_cents * 365 * 10000, daysInPeriod * principal) : 0;
    const totalPrincipal = sum([...allUnits], (u) => (units[u] ? units[u].principal_outstanding_cents : 0));
    Object.assign(out, {
      cash_interest_cents,
      accrued_interest_cents: issuer.accrued_interest_cents || 0,
      capitalized_interest_cents: issuer.capitalized_interest_cents || 0,
      reported_yield_bps: issuer.reported_yield_bps,
      cash_yield_bps,
      yield_gap_bps: Math.max(0, issuer.reported_yield_bps - cash_yield_bps),
      late_share_bps: ratioBps(late60, totalPrincipal, 0),
    });
  } else {
    const rentDue = inPeriod.filter((d) => d.component === "rent");
    const rent_due_cents = sum(rentDue, (d) => d.amount_due_cents);
    const rent_collected_cents = sum(rentDue, settledCapped);
    // bank rows inside the reporting period only (by posted_date); reversed rows are already marked
    const inPeriodRows = m.bank.filter((t) => t.posted_date.slice(0, 7) === period);
    const debitsOf = (kind) => inPeriodRows.filter((t) => t.amount_cents < 0 && t.kind_hint === kind && t.outcome === kind);
    let distributions_cents = -sum(debitsOf("distribution"), (t) => t.amount_cents);
    if (distributions_cents === 0 && (issuer.distributions_paid_cents || 0) > 0) {
      distributions_cents = issuer.distributions_paid_cents;
      flags.push("distributions_self_reported");
    }
    out.exceptions.distribution_funded_by_sponsor = debitsOf("distribution").filter((t) => t.funded_by_sponsor).length;
    let expenses_cents = -sum(debitsOf("expense"), (t) => t.amount_cents);
    if (expenses_cents === 0 && (issuer.expenses_cents || 0) > 0) {
      expenses_cents = issuer.expenses_cents;
      flags.push("expenses_self_reported");
    }
    const net_operating_cash_cents = rent_collected_cents - expenses_cents - (issuer.reserves_cents || 0);
    Object.assign(out, {
      rent_due_cents,
      rent_collected_cents,
      collection_rate_bps: ratioBps(rent_collected_cents, rent_due_cents, 10000),
      occupancy_bps: issuer.occupancy_bps,
      expenses_cents,
      reserves_cents: issuer.reserves_cents || 0,
      net_operating_cash_cents,
      distributions_cents,
      rental_coverage_bps: distributions_cents === 0 ? 10000 : net_operating_cash_cents <= 0 ? 0 : rhu(10000 * net_operating_cash_cents, distributions_cents),
      late_share_bps: ratioBps(late60, rent_due_cents, 0),
    });
  }
  return out;
}

/** The input score() takes, from metrics and the evidence passport sources. */
export function scoreInput(mt, sources) {
  return {
    kind: mt.kind,
    cash_match_bps: mt.cash_match_bps,
    yield_gap_bps: mt.yield_gap_bps,
    rental_coverage_bps: mt.rental_coverage_bps,
    late_share_bps: mt.late_share_bps,
    claimed_cash_cents: mt.claimed_cash_cents,
    exceptions: { claimed_not_settled_cents: mt.exceptions.claimed_not_settled_cents, distribution_funded_by_sponsor: mt.exceptions.distribution_funded_by_sponsor },
    sources,
  };
}

/** Public metrics block: every cohort with fewer than MIN_COHORT units is suppressed (spec section 9). */
export function publicMetrics(mt) {
  const cohorts = Object.fromEntries(Object.entries(mt.cohorts).map(([c, v]) => [c, v.units > 0 && v.units < MIN_COHORT ? { suppressed: "fewer than 5" } : v]));
  return { ...mt, cohorts };
}
