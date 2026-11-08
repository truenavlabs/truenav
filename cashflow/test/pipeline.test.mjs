// End to end on the synthetic demo data: adapters, three-way match, metrics, score. Pins the demo story (spec
// section 12): both demo funds land red with stated reasons, both honest funds green; every edge case shows up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { datasets, AS_OF, PERIOD, DAYS_IN_PERIOD } from "../demo/data.mjs";
import { runFund } from "../run.mjs";
import { settledFromFeed } from "../adapters/bank.mjs";
import { publicMetrics } from "../metrics.mjs";
import { ref } from "../pseudo.mjs";

const KEY = "test-pseudonym-key-0123456789"; // gitleaks:allow (fixed test pseudonym key, not a secret)
const opts = { key: KEY, asOf: `${AS_OF}T00:00:00Z`, period: PERIOD, daysInPeriod: DAYS_IN_PERIOD, bankFetchedAt: "2026-10-31T22:00:00Z" };
const runs = Object.fromEntries(datasets().map((ds) => [ds.id, runFund(ds, opts)]));
const codes = (r) => r.score.caps.map((c) => c.code);

test("demo credit fund: reported 11.00%, cash yield near 6%, red with the yield-gap and claimed-not-settled reasons", () => {
  const r = runs["DEMO-CREDIT"];
  assert.equal(r.metrics.reported_yield_bps, 1100);
  assert.ok(r.metrics.cash_yield_bps >= 550 && r.metrics.cash_yield_bps <= 650, `cash yield ${r.metrics.cash_yield_bps}`);
  assert.ok(r.metrics.capitalized_interest_cents > 0, "interest added to the loan is shown, never counted as cash");
  assert.equal(r.score.band, "red");
  assert.ok(codes(r).includes("yield_gap") && codes(r).includes("claimed_not_settled"));
  assert.equal(r.metrics.cohorts["60"].units, 3, "60+ day late payers");
});

test("demo rental token: payouts exceed net cash, sponsor-funded payout, occupancy above collection; red", () => {
  const r = runs["DEMO-RENTAL"];
  assert.ok(r.metrics.rental_coverage_bps < 10000, `coverage ${r.metrics.rental_coverage_bps}`);
  assert.ok(r.metrics.occupancy_bps > r.metrics.collection_rate_bps, "occupancy is not collection");
  assert.equal(r.score.band, "red");
  for (const c of ["payout_exceeds_net_cash", "distribution_funded_by_sponsor"]) assert.ok(codes(r).includes(c), c);
  assert.ok(r.score.caps.some((c) => c.reason === "red because payouts exceed net cash from rent"));
});

test("honest credit fund and honest rental token land green with no caps", () => {
  for (const id of ["HONEST-CREDIT", "HONEST-RENTAL"]) {
    assert.equal(runs[id].score.band, "green", id);
    assert.deepEqual(codes(runs[id]), [], id);
  }
});

test("edge cases appear in the demo data and are handled: batch, bounce, duplicate, security deposit, pending", () => {
  const m = runs["DEMO-RENTAL"].match;
  assert.ok(m.bank.some((t) => t.outcome === "settles_batch"), "batched manager deposit");
  assert.ok(m.bank.some((t) => t.outcome === "reversed"), "bounced payment");
  assert.equal(m.exceptions.duplicate_bank_txn, 1, "duplicated bank line");
  assert.ok(m.bank.some((t) => t.outcome === "security_deposit"), "security deposit is not rent");
  assert.ok(m.bank.some((t) => t.outcome === "owner_transfer"), "sponsor transfer is not rent");
  const ds = datasets().find((d) => d.id === "DEMO-RENTAL");
  assert.equal(settledFromFeed(ds.bank_feed, KEY).length, ds.bank_feed.transactions.filter((t) => !t.pending).length, "pending transactions are not settled cash");
});

test("the bank adapter flips the aggregator sign convention and pseudonymizes counterparties", () => {
  const s = settledFromFeed({ transactions: [{ transaction_id: "x", date: "2026-10-02", amount_cents: -1000, counterparty: "Tenant A", category: "RENT", pending: false }] }, KEY);
  assert.equal(s[0].amount_cents, 1000);
  assert.equal(s[0].kind_hint, "rent");
  assert.notEqual(s[0].counterparty_ref, "Tenant A");
  assert.equal(s[0].counterparty_ref, ref(KEY, "payer", "TENANT A"));
});

test("no name, unit id or payer appears in the public metrics or the score", () => {
  for (const ds of datasets()) {
    const r = runs[ds.id];
    const pub = JSON.stringify({ m: r.public_metrics, s: r.score });
    const names = ds.kind === "credit" ? ds.servicer_tape.loans.flatMap((l) => [l.loan_id, l.borrower_payer]) : ds.manager_export.units.flatMap((u) => [u.unit_id, u.tenant_payer].filter(Boolean));
    for (const n of names) assert.ok(!pub.includes(n), `${ds.id}: ${n} leaked`);
  }
});

test("cohorts under 5 units are suppressed in the public block", () => {
  const pub = publicMetrics(runs["DEMO-RENTAL"].metrics);
  assert.deepEqual(pub.cohorts["60"], { suppressed: "fewer than 5" });
  assert.equal(typeof pub.cohorts.current.units, "number");
});

test("the evidence passport marks every demo source synthetic and the bank source as tier 3", () => {
  for (const r of Object.values(runs)) {
    assert.ok(r.passport.every((p) => p.synthetic === true));
    const bank = r.passport.find((p) => p.source === "bank_settlements");
    assert.deepEqual([bank.tier, bank.cadence, bank.age_hours], [3, "daily", 2]);
  }
});

test("a carried-forward bank snapshot in a new period drops the fund to self-reported only", () => {
  const ds = datasets().find((d) => d.id === "HONEST-CREDIT");
  const first = runFund(ds, opts);
  const prev = Object.fromEntries(first.passport.map((p) => [p.source, p.snapshot_sha256]));
  assert.equal(runFund(ds, { ...opts, previous: prev, newPeriod: false }).score.band, "green", "same period, unchanged snapshot is fine");
  const again = runFund(ds, { ...opts, previous: prev, newPeriod: true });
  assert.ok(codes(again).includes("self_reported_only"));
});

test("runs are deterministic", () => {
  const a = runFund(datasets()[1], opts);
  const b = runFund(datasets()[1], opts);
  assert.deepEqual(a, b);
});
