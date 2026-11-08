// End to end on the synthetic demo data: adapters, three-way match, metrics, score. Pins the demo story (spec
// section 12): both demo funds land red with stated reasons, both honest funds green; every edge case shows up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { datasets, RUN_AS_OF, BANK_FETCHED_AT, PERIOD, DAYS_IN_PERIOD } from "../demo/data.mjs";
import { runFund, RunError, toUtc } from "../run.mjs";
import { settledFromFeed } from "../adapters/bank.mjs";
import { publicMetrics } from "../metrics.mjs";
import { ref } from "../pseudo.mjs";

const KEY = "test-pseudonym-key-0123456789"; // gitleaks:allow (fixed test pseudonym key, not a secret)
const opts = { key: KEY, asOf: RUN_AS_OF, period: PERIOD, daysInPeriod: DAYS_IN_PERIOD, bankFetchedAt: BANK_FETCHED_AT };
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
    assert.deepEqual([bank.tier, bank.cadence, bank.age_hours], [3, "daily", 1]); // fetched 08:30, run 09:00: half an hour, rounded half up
  }
});

const passportPrev = (r) => Object.fromEntries(r.passport.map((p) => [p.source, { snapshot_sha256: p.snapshot_sha256, as_of: p.as_of }]));

test("a carried-forward bank snapshot in a new period drops the fund to self-reported only", () => {
  const ds = datasets().find((d) => d.id === "HONEST-CREDIT");
  const prev = passportPrev(runFund(ds, opts));
  assert.equal(runFund(ds, { ...opts, previous: prev, newPeriod: false }).score.band, "green", "same period, unchanged snapshot is fine");
  const again = runFund(ds, { ...opts, previous: prev, newPeriod: true });
  assert.ok(codes(again).includes("self_reported_only"));
});

test("carried forward when the bytes changed but the source's as_of did not advance", () => {
  const ds = datasets().find((d) => d.id === "HONEST-RENTAL");
  const first = runFund(ds, opts);
  const changed = structuredClone(ds);
  changed.manager_export.ledger[0].batch_ref = "edited-later"; // different bytes, same export as_of
  const next = runFund(changed, { ...opts, bankFetchedAt: "2026-11-08T08:45:00Z", previous: passportPrev(first), newPeriod: true });
  const mgr = next.passport.find((p) => p.source === "property_manager_records");
  assert.notEqual(mgr.snapshot_sha256, first.passport.find((p) => p.source === "property_manager_records").snapshot_sha256);
  assert.equal(mgr.carried_forward, true);
  assert.equal(mgr.freshness_bps, 0);
  // the bank fetch time advanced but its bytes are identical: carried forward by the same-hash rule
  assert.equal(next.passport.find((p) => p.source === "bank_settlements").carried_forward, true);
});

test("issuer claims use the issuer's own as_of: a January issuer is stale", () => {
  const ds = structuredClone(datasets().find((d) => d.id === "HONEST-CREDIT"));
  ds.issuer.as_of = "2026-01-31";
  const r = runFund(ds, opts);
  const iss = r.passport.find((p) => p.source === "issuer_claims");
  assert.equal(iss.as_of, "2026-01-31T00:00:00Z");
  assert.equal(iss.freshness_bps, 0);
  assert.equal(r.score.parts_x100.freshness, 0, "issuer claims are a required source");
  assert.ok(r.score.score < runFund(datasets().find((d) => d.id === "HONEST-CREDIT"), opts).score.score);
});

test("carried_forward is computed for the issuer too, never hardcoded", () => {
  const ds = datasets().find((d) => d.id === "HONEST-CREDIT");
  const prev = passportPrev(runFund(ds, opts));
  const r = runFund(ds, { ...opts, bankFetchedAt: "2026-11-08T08:45:00Z", previous: prev, newPeriod: true });
  assert.equal(r.passport.find((p) => p.source === "issuer_claims").carried_forward, true);
});

test("runs are deterministic", () => {
  const a = runFund(datasets()[1], opts);
  const b = runFund(datasets()[1], opts);
  assert.deepEqual(a, b);
});

test("period scope: an extra September distribution does not change honest rental's October coverage or score", () => {
  const ds = datasets().find((d) => d.id === "HONEST-RENTAL");
  const base = runFund(ds, opts);
  const extra = structuredClone(ds);
  extra.bank_feed.transactions.push({ transaction_id: "bk-extra-sep-payout", date: "2026-09-30", amount_cents: 9_000_000, counterparty: "Linden Court token holders", category: "DISTRIBUTION", pending: false });
  extra.bank_feed.transactions.push({ transaction_id: "bk-extra-sep-sponsor", date: "2026-09-28", amount_cents: -9_000_000, counterparty: "Linden Court Sponsor LP", category: "OWNER_TRANSFER", pending: false });
  extra.bank_feed.transactions.push({ transaction_id: "bk-extra-sep-expense", date: "2026-09-15", amount_cents: 5_000_000, counterparty: "Linden Court Property Services", category: "EXPENSE", pending: false });
  const r = runFund(extra, opts);
  assert.equal(r.metrics.rental_coverage_bps, base.metrics.rental_coverage_bps);
  assert.equal(r.metrics.distributions_cents, base.metrics.distributions_cents);
  assert.equal(r.metrics.expenses_cents, base.metrics.expenses_cents);
  assert.equal(r.metrics.exceptions.distribution_funded_by_sponsor, 0);
  assert.deepEqual([r.score.score, r.score.band, codes(r)], [base.score.score, base.score.band, codes(base)]);
});

test("sources are validated up front: a missing source or a missing or null as_of fails closed with a named code", () => {
  const base = () => datasets().find((d) => d.id === "DEMO-RENTAL");
  const fails = (ds, code, o = opts) => assert.throws(() => runFund(ds, o), (e) => e instanceof RunError && e.code === code, code);
  fails({ ...base(), issuer: { ...base().issuer, as_of: null } }, "as_of_missing_issuer_claims");
  const noAsOf = { ...base().issuer };
  delete noAsOf.as_of;
  fails({ ...base(), issuer: noAsOf }, "as_of_missing_issuer_claims");
  fails({ ...base(), manager_export: { ...base().manager_export, as_of: null } }, "as_of_missing_property_manager_records");
  const credit = datasets().find((d) => d.id === "DEMO-CREDIT");
  fails({ ...credit, servicer_tape: { ...credit.servicer_tape, as_of: undefined } }, "as_of_missing_servicer_records");
  fails(base(), "as_of_missing_bank_settlements", { ...opts, bankFetchedAt: null });
  fails({ ...base(), issuer: { ...base().issuer, as_of: "31/10/2026" } }, "as_of_invalid_issuer_claims");
  fails(base(), "as_of_invalid_run", { ...opts, asOf: "2026-11-01T00:00:00" });
  fails({ ...base(), bank_feed: null }, "source_missing_bank_settlements");
  fails({ ...base(), manager_export: undefined }, "source_missing_property_manager_records");
  fails({ ...base(), issuer: null }, "source_missing_issuer_claims");
});

test("timestamps are normalized to UTC: the same instant as Z and as +07:00 gives identical results", () => {
  const ds = () => datasets().find((d) => d.id === "DEMO-CREDIT");
  const z = runFund(ds(), opts);
  // run time and fetch time are parameters: the whole result is identical
  const plus7 = runFund(ds(), { ...opts, asOf: "2026-11-08T16:00:00+07:00", bankFetchedAt: "2026-11-08T15:30:00+07:00" });
  assert.deepEqual(plus7, z);
  // as_of inside the documents: everything but the snapshot hashes of the edited documents is identical
  const d = ds();
  d.issuer.as_of = "2026-11-08T13:00:00+07:00"; // 2026-11-08T06:00:00Z, the export time
  d.servicer_tape.as_of = "2026-11-08T01:00:00-05:00"; // the same instant
  const docs = runFund(d, opts);
  const strip = (r) => ({ ...r, passport: r.passport.map(({ snapshot_sha256, ...x }) => x) });
  assert.deepEqual(strip(docs), strip(z));
  assert.equal(docs.passport[2].as_of, "2026-11-08T06:00:00Z");
  // a date is taken only after normalizing: 05:00+07:00 on 1 Nov is still 31 Oct in UTC
  assert.equal(toUtc("2026-11-01T05:00:00+07:00"), "2026-10-31T22:00:00Z");
  assert.equal(toUtc("2026-10-31T17:00:00-05:00"), "2026-10-31T22:00:00Z");
  for (const bad of ["2026-02-30", "2026-10-31T24:00:00Z", "2026-10-31T22:00:00", "2026-10-31T22:00Z", "2026-10-31T22:00:00+0700", "1969-12-31T23:59:59Z", "", null, 5]) assert.equal(toUtc(bad), null, String(bad));
});
