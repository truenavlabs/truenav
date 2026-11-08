// cashflow-v2.1.0 collection_shortfall (spec/v2/SPEC.md section 5.7): for the latest completed period, contractual
// dues D against bank-settled, claim-linked cash V posted by the cutoff (period end + 7 days, UTC). 10V < 9D caps the
// score at 59 with the rate in the reason. Synthetic one-fund datasets; every name is fictional.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runFund, RunError } from "../run.mjs";
import { cutoff } from "../metrics.mjs";

const KEY = "collection-test-pseudonym-key-0001"; // gitleaks:allow (fixed test pseudonym key, not a secret)
const AFTER = "2026-11-08T00:00:00Z"; // October's cutoff is 2026-11-07, so this run can verify October
// units: [{ rent, paid: [[paid_date, amount, posted_date]] , occupied?, extra? }]
function fund(units, { asOf = AFTER, exportAsOf = AFTER } = {}) {
  const id = "COLL-TEST";
  const u = units.map((x, i) => ({ unit_id: `${id}-U${i}`, occupied: x.occupied !== false, tenant_payer: `Tenant ${id} ${i}`, rent_cents: x.rent }));
  const charges = units.flatMap((x, i) => (x.occupied === false ? [] : [{ unit_id: `${id}-U${i}`, due_date: "2026-10-01", amount_cents: x.rent, ...(x.extra || {}) }]));
  const ledger = [];
  const txns = [];
  units.forEach((x, i) =>
    (x.paid || []).forEach(([paid, amt, posted, kind], j) => {
      if (paid) ledger.push({ entry_id: `${id}-U${i}-${j}`, unit_id: `${id}-U${i}`, paid_date: paid, amount_cents: amt, status: "paid", batch_ref: null });
      txns.push({ transaction_id: `bk-${id}-U${i}-${j}`, date: posted, amount_cents: -amt, counterparty: `Tenant ${id} ${i}`, category: kind || "RENT", pending: false });
    }),
  );
  const ds = {
    id, name: "Collection test (synthetic)", kind: "rental", synthetic: true,
    manager_export: { as_of: exportAsOf, units: u, charges, ledger },
    bank_feed: { synthetic: true, account_id: `${id}-operating`, transactions: txns },
    issuer: { token_id: id, as_of: exportAsOf, period: "2026-10", occupancy_bps: 10000, expenses_cents: 0, reserves_cents: 0, distributions_paid_cents: 0 },
  };
  return { ds, opts: { key: KEY, asOf, period: "2026-10", daysInPeriod: 31, bankFetchedAt: asOf } };
}
const run = ({ ds, opts }) => runFund(ds, opts);
const codes = (r) => r.score.caps.map((c) => c.code);

test("cutoff is period end + 7 calendar days, UTC", () => {
  assert.deepEqual(cutoff("2026-10"), { cutoff: "2026-11-07", ends_ms: Date.parse("2026-11-08T00:00:00Z") });
  assert.equal(cutoff("2026-02").cutoff, "2026-03-07");
  assert.equal(cutoff("2024-02").cutoff, "2024-03-07");
  assert.equal(cutoff("2026-12").cutoff, "2027-01-07");
});

test("gap case: one unit, one unpaid 100-cent due: uncapped 100, final 59 red with collection_shortfall", () => {
  const r = run(fund([{ rent: 100 }]));
  assert.equal(r.metrics.collection.status, "verified");
  assert.equal(r.metrics.collection.dues_cents, 100);
  assert.equal(r.metrics.collection.verified_cents, 0);
  assert.equal(r.score.uncapped_score, 100);
  assert.equal(r.score.score, 59);
  assert.equal(r.score.band, "red");
  assert.deepEqual(codes(r), ["collection_shortfall"]);
  const reason = r.score.caps[0].reason;
  assert.equal(reason, "red because of unverified collection: 0.00% of contractual dues for 2026-10 were bank-confirmed by 2026-11-07 (at least 90.00% needed)");
  assert.ok(!/default/i.test(JSON.stringify(r.score)), "never called a default");
});

test("exactly 90% passes; 89.99% caps (integer test before rounding)", () => {
  const ninety = run(fund([{ rent: 10000, paid: [["2026-10-02", 9000, "2026-10-03"]] }]));
  assert.equal(ninety.metrics.collection.rate_bps, 9000);
  assert.equal(ninety.metrics.collection.shortfall, false);
  assert.ok(!codes(ninety).includes("collection_shortfall"));
  const below = run(fund([{ rent: 10000, paid: [["2026-10-02", 8999, "2026-10-03"]] }]));
  assert.equal(below.metrics.collection.rate_bps, 8999);
  assert.deepEqual(codes(below), ["collection_shortfall"]);
  assert.match(below.score.caps[0].reason, /89\.99% of contractual dues/);
  // 8,999,999 of 10,000,000 rounds to 9,000 bps but is below 90%: the integer test decides
  const r = run(fund([{ rent: 10_000_000, paid: [["2026-10-02", 8_999_999, "2026-10-03"]] }]));
  assert.equal(r.metrics.collection.rate_bps, 9000);
  assert.ok(codes(r).includes("collection_shortfall"));
});

test("no unit-count or dollar exemption: 1 of 10 units unpaid is 90% (passes), 2 of 10 caps", () => {
  const paid = { rent: 100, paid: [["2026-10-02", 100, "2026-10-03"]] };
  assert.ok(!codes(run(fund([...Array(9).fill(paid), { rent: 100 }]))).includes("collection_shortfall"));
  assert.ok(codes(run(fund([...Array(8).fill(paid), { rent: 100 }, { rent: 100 }]))).includes("collection_shortfall"));
});

test("only bank-settled, claim-linked cash posted by the cutoff counts", () => {
  // settled after the cutoff (posted 2026-11-08): not counted
  const late = run(fund([{ rent: 100, paid: [["2026-11-06", 100, "2026-11-08"]] }]));
  assert.equal(late.metrics.collection.verified_cents, 0);
  // posted on the cutoff day: counted
  const onT = run(fund([{ rent: 100, paid: [["2026-11-06", 100, "2026-11-07"]] }]));
  assert.equal(onT.metrics.collection.verified_cents, 100);
  // M5: the tenant's bank cash with no manager claim does not count
  const unclaimed = run(fund([{ rent: 100, paid: [[null, 100, "2026-10-02"]] }]));
  assert.equal(unclaimed.metrics.collection.verified_cents, 0);
  assert.ok(codes(unclaimed).includes("collection_shortfall"));
  // a claim the bank never settled does not count
  const claimedOnly = run(fund([{ rent: 100, paid: [["2026-10-02", 100, "2026-12-30"]] }]));
  assert.equal(claimedOnly.metrics.collection.verified_cents, 0);
  // a security deposit from the tenant never counts, even with a manager entry
  const deposit = run(fund([{ rent: 100, paid: [["2026-10-02", 100, "2026-10-03", "SECURITY_DEPOSIT"]] }]));
  assert.equal(deposit.metrics.collection.verified_cents, 0);
});

test("capped per obligation and each cent once: two settled claims on one due count up to the due only", () => {
  const r = run(fund([{ rent: 100, paid: [["2026-10-02", 60, "2026-10-03"], ["2026-10-04", 40, "2026-10-05"]] }, { rent: 100 }]));
  assert.equal(r.metrics.collection.dues_cents, 200);
  assert.equal(r.metrics.collection.verified_cents, 100);
  assert.equal(r.metrics.collection.rate_bps, 5000);
});

test("later write-offs never erase historical dues", () => {
  const r = run(fund([{ rent: 100, extra: { written_off: true, status: "written_off" } }, { rent: 100, paid: [["2026-10-02", 100, "2026-10-03"]] }]));
  assert.equal(r.metrics.collection.dues_cents, 200);
  assert.ok(codes(r).includes("collection_shortfall"));
});

test("verified zero dues: collection N/A, no cap, but not green on inactivity alone", () => {
  const r = run(fund([{ rent: 100, occupied: false }, { rent: 100, occupied: false }]));
  assert.equal(r.metrics.collection.status, "not_applicable");
  assert.equal(r.metrics.collection.rate_bps, null);
  assert.ok(!codes(r).includes("collection_shortfall"));
  assert.deepEqual(r.score.holds.map((h) => h.code), ["collection_not_applicable"]);
  assert.notEqual(r.score.band, "green");
  assert.ok(r.score.score <= 84);
});

test("missing or incomplete dues fail closed with a named error", () => {
  const fails = (f, code, mut) => {
    const x = f();
    mut(x.ds);
    assert.throws(() => run(x), (e) => e instanceof RunError && e.code === code, code);
  };
  const one = () => fund([{ rent: 100 }]);
  fails(one, "dues_missing", (ds) => delete ds.manager_export.charges);
  fails(one, "dues_missing", (ds) => (ds.manager_export.units = null));
  fails(one, "dues_incomplete", (ds) => delete ds.manager_export.charges[0].amount_cents);
  fails(one, "dues_incomplete", (ds) => (ds.manager_export.charges[0].due_date = "2026-10-32"));
  fails(one, "dues_incomplete", (ds) => (ds.manager_export.charges[0].amount_cents = -1));
  // an occupied unit with a rent but no charge in the verified period
  fails(one, "dues_incomplete", (ds) => (ds.manager_export.charges = []));
});

test("before the cutoff, or without source coverage through it: pending, not green", () => {
  // mid-October run: September's cutoff (2026-10-07) has not passed either
  const early = run(fund([{ rent: 100, paid: [["2026-09-02", 100, "2026-09-03"]] }], { asOf: "2026-10-05T00:00:00Z", exportAsOf: "2026-10-05T00:00:00Z" }));
  assert.equal(early.metrics.collection.status, "pending");
  assert.equal(early.metrics.collection.pending_reason, "before_cutoff");
  assert.deepEqual(early.score.holds.map((h) => h.code), ["collection_pending"]);
  assert.notEqual(early.score.band, "green");
  // after the cutoff, but the manager export stops before it
  const stale = run(fund([{ rent: 100, paid: [["2026-10-02", 100, "2026-10-03"]] }], { exportAsOf: "2026-11-05T00:00:00Z" }));
  assert.equal(stale.metrics.collection.status, "pending");
  assert.equal(stale.metrics.collection.pending_reason, "no_coverage_property_manager_records");
  assert.notEqual(stale.score.band, "green");
  // the same fund once coverage reaches the cutoff: verified and green
  const ok = run(fund([{ rent: 100, paid: [["2026-10-02", 100, "2026-10-03"]] }]));
  assert.equal(ok.metrics.collection.status, "verified");
  assert.equal(ok.score.band, "green");
});

test("the run's reporting period is checked once its cutoff passes; before that, the previous period", () => {
  const x = fund([{ rent: 100 }], { asOf: "2026-11-07T23:59:59Z", exportAsOf: "2026-11-07T23:59:59Z" });
  x.ds.manager_export.charges.push({ unit_id: "COLL-TEST-U0", due_date: "2026-09-01", amount_cents: 100 });
  const before = run(x);
  assert.equal(before.metrics.collection.period, "2026-09");
  assert.equal(before.metrics.collection.cutoff, "2026-10-07");
  // without a September charge for the occupied unit, the September check fails closed
  assert.throws(() => run(fund([{ rent: 100 }], { asOf: "2026-11-07T23:59:59Z", exportAsOf: "2026-11-07T23:59:59Z" })), (e) => e.code === "dues_incomplete");
  const after = run(fund([{ rent: 100 }]));
  assert.equal(after.metrics.collection.period, "2026-10");
});
