// Metrics unit tests (spec/v2/SPEC.md section 5) with hand-computed numbers. Synthetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { match } from "../match.mjs";
import { metrics, publicMetrics } from "../metrics.mjs";

const due = (id, unit, date, amt, component) => ({ due_id: id, kind: component === "rent" ? "lease" : "loan", unit_ref: unit, component, due_date: date, amount_due_cents: amt, period: date.slice(0, 7) });
const claim = (id, unit, date, amt) => ({ claim_id: id, due_id: null, unit_ref: unit, paid_date: date, amount_cents: amt, status: "paid", batch_ref: null });
const txn = (id, date, amt, cp, kind) => ({ txn_id: id, posted_date: date, amount_cents: amt, counterparty_ref: cp, kind_hint: kind, reversal_of: null });
const AS_OF = "2026-11-01";

test("cash yield: 300,000 cents of interest in 31 days on 10,000,000 cents = 3,532 bps; gap to 4,000 reported = 468", () => {
  const units = ["A", "B", "C"];
  const m = match({
    due: units.map((u) => due(`D${u}`, u, "2026-10-01", 100000, "interest")),
    claims: units.map((u) => claim(`C${u}`, u, "2026-10-01", 100000)),
    bank: units.map((u) => txn(`T${u}`, "2026-10-02", 100000, `cp-${u}`, "loan_payment")),
    payers: Object.fromEntries(units.map((u) => [`cp-${u}`, u])),
  });
  const mt = metrics({ kind: "credit", m, issuer: { reported_yield_bps: 4000, principal_outstanding_cents: 10_000_000 }, units: Object.fromEntries(units.map((u) => [u, { principal_outstanding_cents: 3_333_333 }])), asOf: AS_OF, period: "2026-10", daysInPeriod: 31 });
  // 300000 x 365 x 10000 / (31 x 10000000) = 3532.258...
  assert.equal(mt.cash_interest_cents, 300000);
  assert.equal(mt.cash_yield_bps, 3532);
  assert.equal(mt.yield_gap_bps, 468);
  assert.equal(mt.cash_match_bps, 10000);
});

function rental({ collected = 5, dueUnits = 6, expense = 200000, distribution = 800000, issuer = {} } = {}) {
  const units = Array.from({ length: dueUnits }, (_, i) => `U${i}`);
  const bank = units.slice(0, collected).map((u) => txn(`T${u}`, "2026-10-03", 200000, `cp-${u}`, "rent"));
  if (expense) bank.push(txn("TE", "2026-10-15", -expense, "cp-ops", "expense"));
  if (distribution) bank.push(txn("TD", "2026-10-30", -distribution, "cp-holders", "distribution"));
  const m = match({
    due: units.map((u) => due(`D${u}`, u, "2026-10-01", 200000, "rent")),
    claims: units.slice(0, collected).map((u) => claim(`C${u}`, u, "2026-10-02", 200000)),
    bank,
    payers: Object.fromEntries(units.map((u) => [`cp-${u}`, u])),
  });
  return metrics({ kind: "rental", m, issuer: { occupancy_bps: 10000, reserves_cents: 100000, ...issuer }, asOf: AS_OF, period: "2026-10", daysInPeriod: 31 });
}

test("rental: collected 1,000,000 of 1,200,000 due = 8,333 bps; NOC 1,000,000 - 200,000 - 100,000 = 700,000; coverage vs 800,000 = 8,750 bps", () => {
  const mt = rental();
  assert.deepEqual([mt.rent_due_cents, mt.rent_collected_cents, mt.collection_rate_bps], [1_200_000, 1_000_000, 8333]);
  assert.deepEqual([mt.expenses_cents, mt.net_operating_cash_cents, mt.distributions_cents, mt.rental_coverage_bps], [200_000, 700_000, 800_000, 8750]);
  assert.equal(mt.occupancy_bps, 10000, "occupancy is reported as is, never used as collection");
  assert.deepEqual(mt.flags, []);
});

test("no bank distribution or expense rows: the issuer's figures are used and flagged self-reported", () => {
  const mt = rental({ expense: 0, distribution: 0, issuer: { distributions_paid_cents: 500000, expenses_cents: 150000 } });
  assert.deepEqual([mt.distributions_cents, mt.expenses_cents], [500000, 150000]);
  assert.deepEqual(mt.flags.sort(), ["distributions_self_reported", "expenses_self_reported"]);
});

test("cohort boundaries: 29 current, 30 and 59 in 30, 60 and 89 in 60, 90 in 90+", () => {
  const dpdDate = { 29: "2026-10-03", 30: "2026-10-02", 59: "2026-09-03", 60: "2026-09-02", 89: "2026-08-04", 90: "2026-08-03" };
  const m = match({ due: Object.entries(dpdDate).map(([d, date]) => due(`D${d}`, `U${d}`, date, 100000, "rent")), claims: [], bank: [], payers: {} });
  const mt = metrics({ kind: "rental", m, issuer: { occupancy_bps: 10000 }, asOf: AS_OF, period: "2026-10", daysInPeriod: 31 });
  assert.deepEqual(Object.fromEntries(Object.entries(mt.cohorts).map(([k, v]) => [k, v.units])), { current: 1, 30: 2, 60: 2, "90+": 1 });
});

test("a due item paid in full is current however old it is; a future due item is not late", () => {
  const m = match({ due: [due("D1", "U1", "2026-08-01", 100000, "rent"), due("D2", "U2", "2026-11-15", 100000, "rent")], claims: [claim("C1", "U1", "2026-08-01", 100000)], bank: [txn("T1", "2026-08-02", 100000, "cp-1", "rent")], payers: { "cp-1": "U1" } });
  const mt = metrics({ kind: "rental", m, issuer: { occupancy_bps: 10000 }, asOf: AS_OF, period: "2026-10", daysInPeriod: 31 });
  assert.equal(mt.cohorts.current.units, 2);
});

test("suppression: a cohort of 4 units is suppressed in the public block, 5 is shown", () => {
  const mt = { cohorts: { current: { units: 5, outstanding_cents: 1 }, 30: { units: 4, outstanding_cents: 1 }, 60: { units: 0, outstanding_cents: 0 }, "90+": { units: 1, outstanding_cents: 1 } } };
  const pub = publicMetrics(mt);
  assert.deepEqual(pub.cohorts["30"], { suppressed: "fewer than 5" });
  assert.deepEqual(pub.cohorts["90+"], { suppressed: "fewer than 5" });
  assert.equal(pub.cohorts.current.units, 5);
  assert.equal(pub.cohorts["60"].units, 0, "an empty cohort reveals nobody");
});

test("late share, credit: principal of loans in the 60 and 90+ cohorts over all principal", () => {
  const m = match({ due: [due("D1", "A", "2026-09-01", 1000, "interest"), due("D2", "B", "2026-10-01", 1000, "interest")], claims: [], bank: [], payers: {} });
  const mt = metrics({ kind: "credit", m, issuer: { reported_yield_bps: 1000, principal_outstanding_cents: 4_000_000 }, units: { A: { principal_outstanding_cents: 1_000_000 }, B: { principal_outstanding_cents: 1_000_000 }, C: { principal_outstanding_cents: 2_000_000 } }, asOf: AS_OF, period: "2026-10", daysInPeriod: 31 });
  // A is 61 days late (60 cohort), B 31 (30 cohort), C current: 1,000,000 / 4,000,000 = 2,500 bps
  assert.equal(mt.late_share_bps, 2500);
});

test("cash match uses one claim cohort (paid in the period): a September claim is outside October's numerator and denominator", () => {
  const m = match({
    due: [due("D1", "A", "2026-09-01", 1000, "rent"), due("D2", "A", "2026-10-01", 1000, "rent"), due("D3", "B", "2026-10-01", 1000, "rent")],
    claims: [claim("C1", "A", "2026-09-02", 1000), claim("C2", "A", "2026-10-02", 1000), claim("C3", "B", "2026-10-02", 1000)],
    bank: [txn("T1", "2026-09-03", 1000, "cp-A", "rent"), txn("T2", "2026-10-03", 1000, "cp-A", "rent")],
    payers: { "cp-A": "A", "cp-B": "B" },
  });
  const mt = metrics({ kind: "rental", m, issuer: { occupancy_bps: 10000 }, asOf: AS_OF, period: "2026-10", daysInPeriod: 31 });
  assert.deepEqual([mt.claimed_cash_cents, mt.exceptions.claimed_not_settled_cents, mt.cash_match_bps], [2000, 1000, 5000]);
});
