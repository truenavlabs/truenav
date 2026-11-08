// Every issuer- or source-supplied value that reaches public_metrics is checked for type and range before anything
// runs: a string, a float, a negative or an out-of-range value fails closed with a fixed code that never echoes the
// value (owner review 8 Nov: a string occupancy_bps used to pass straight into public_metrics). Synthetic data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { datasets, AS_OF, PERIOD, DAYS_IN_PERIOD } from "../demo/data.mjs";
import { runFund, RunError, ISSUER_FIELDS } from "../run.mjs";

const KEY = "fields-test-pseudonym-key-0001"; // gitleaks:allow (fixed test pseudonym key, not a secret)
const opts = { key: KEY, asOf: `${AS_OF}T00:00:00Z`, period: PERIOD, daysInPeriod: DAYS_IN_PERIOD, bankFetchedAt: "2026-10-31T22:00:00Z" };
const SENTINEL = "SENTINEL-not-a-number-7731";
const fund = (kind) => datasets().find((d) => d.id === (kind === "credit" ? "HONEST-CREDIT" : "HONEST-RENTAL"));
const failsWith = (ds, code) => {
  let err;
  try {
    runFund(ds, opts);
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof RunError, `${code}: expected a RunError, got ${err}`);
  assert.equal(err.code, code);
  assert.ok(!String(err.message).includes(SENTINEL) && !String(err.code).includes(SENTINEL), "the value is never echoed");
};

test("each issuer field: string, float, negative and above range fail closed; a valid value passes", () => {
  for (const [field, requiredFor, , hi] of ISSUER_FIELDS) {
    for (const kind of requiredFor ? [requiredFor] : ["credit", "rental"]) {
      const above = hi === Number.MAX_SAFE_INTEGER ? 2 ** 53 : hi + 1;
      for (const bad of [SENTINEL, "1000", 12.5, -1, above, true, [1], { v: 1 }]) {
        const ds = fund(kind);
        ds.issuer[field] = bad;
        failsWith(ds, `${field}_invalid`);
      }
      const ok = fund(kind);
      ok.issuer[field] = hi === 10000 ? 10000 : 0;
      assert.doesNotThrow(() => runFund(ok, opts), `${field} ${kind}`);
    }
  }
});

test("required issuer fields: missing or null fails closed; optional ones may be absent", () => {
  for (const [field, kind] of [["occupancy_bps", "rental"], ["reported_yield_bps", "credit"], ["principal_outstanding_cents", "credit"]]) {
    const a = fund(kind);
    delete a.issuer[field];
    failsWith(a, `${field}_invalid`);
    const b = fund(kind);
    b.issuer[field] = null;
    failsWith(b, `${field}_invalid`);
  }
  const r = fund("rental");
  delete r.issuer.expenses_cents;
  delete r.issuer.reserves_cents;
  assert.doesNotThrow(() => runFund(r, opts));
});

test("occupancy_bps reaches public_metrics only as the validated integer", () => {
  const r = runFund(fund("rental"), opts);
  assert.equal(typeof r.public_metrics.occupancy_bps, "number");
  for (const v of [0, 10000]) {
    const ds = fund("rental");
    ds.issuer.occupancy_bps = v;
    assert.equal(runFund(ds, opts).public_metrics.occupancy_bps, v);
  }
});

test("source rows: roster, claims and bank transactions with a bad amount, flag or date fail closed", () => {
  const cases = [
    ["credit", "roster_invalid", (d) => (d.servicer_tape.loans[0].principal_cents = SENTINEL)],
    ["credit", "roster_invalid", (d) => (d.servicer_tape.loans[0].principal_cents = -5)],
    ["rental", "roster_invalid", (d) => (d.manager_export.units[0].rent_cents = 1.5)],
    ["rental", "roster_invalid", (d) => (d.manager_export.units[0].occupied = "yes")],
    ["credit", "claim_invalid", (d) => (d.servicer_tape.payments[0].amount_cents = SENTINEL)],
    ["rental", "claim_invalid", (d) => (d.manager_export.ledger[0].amount_cents = -100)],
    ["rental", "claim_invalid", (d) => (d.manager_export.ledger[0].paid_date = "2026-13-40")],
    ["credit", "claim_invalid", (d) => delete d.servicer_tape.payments],
    ["credit", "bank_txn_invalid", (d) => (d.bank_feed.transactions[0].amount_cents = SENTINEL)],
    ["rental", "bank_txn_invalid", (d) => (d.bank_feed.transactions[0].amount_cents = 0.25)],
    ["rental", "bank_txn_invalid", (d) => (d.bank_feed.transactions[0].date = "31/10/2026")],
    ["credit", "bank_txn_invalid", (d) => (d.bank_feed.transactions = null)],
  ];
  for (const [kind, code, edit] of cases) {
    const ds = fund(kind);
    edit(ds);
    failsWith(ds, code);
  }
  // a negative bank amount is valid: in the feed's convention it is money coming in
  assert.doesNotThrow(() => runFund(fund("rental"), opts));
});
