// Three-way match edge cases (spec/v2/SPEC.md section 4). Every case is synthetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { match } from "../match.mjs";

const due = (id, unit, date, amt, component = "rent") => ({ due_id: id, kind: component === "rent" ? "lease" : "loan", unit_ref: unit, component, due_date: date, amount_due_cents: amt, period: date.slice(0, 7) });
const claim = (id, unit, date, amt, extra = {}) => ({ claim_id: id, due_id: null, unit_ref: unit, paid_date: date, amount_cents: amt, status: "paid", batch_ref: null, ...extra });
const txn = (id, date, amt, cp, kind = "rent", extra = {}) => ({ txn_id: id, posted_date: date, amount_cents: amt, counterparty_ref: cp, kind_hint: kind, reversal_of: null, ...extra });
const payers = { "cp-A": "U-A", "cp-B": "U-B", "cp-C": "U-C" };
const st = (r, id) => r.due.find((d) => d.due_id === id);
const out = (r, id) => r.bank.find((t) => t.txn_id === id).outcome;

test("a claim settled by the bank within the window marks the due paid in full", () => {
  const r = match({ due: [due("D1", "U-A", "2026-10-01", 150000)], claims: [claim("C1", "U-A", "2026-10-01", 150000)], bank: [txn("T1", "2026-10-03", 150000, "cp-A")], payers });
  assert.equal(st(r, "D1").status, "paid_full");
  assert.equal(r.claims[0].settled_by, "T1");
  assert.equal(r.exceptions.claimed_not_settled, 0);
});

test("settlement window is -2 to +5 days: day +6 does not settle", () => {
  const r = match({ due: [due("D1", "U-A", "2026-10-01", 150000)], claims: [claim("C1", "U-A", "2026-10-01", 150000)], bank: [txn("T1", "2026-10-07", 150000, "cp-A")], payers });
  assert.equal(r.claims[0].outcome, "claimed_not_settled");
  assert.equal(r.amounts.claimed_not_settled_cents, 150000);
  // the bank cash still exists but settles no claim: it is reported, never applied to the due item (M5)
  assert.equal(out(r, "T1"), "settled_not_claimed");
  assert.equal(st(r, "D1").status, "unpaid");
  assert.equal(st(r, "D1").settled_cents, 0);
});

test("partial payment: due is paid_partial with the settled amount", () => {
  const r = match({ due: [due("D1", "U-A", "2026-10-01", 150000)], claims: [claim("C1", "U-A", "2026-10-02", 100000, { status: "partial" })], bank: [txn("T1", "2026-10-02", 100000, "cp-A")], payers });
  assert.deepEqual([st(r, "D1").status, st(r, "D1").settled_cents], ["paid_partial", 100000]);
});

test("batched deposit settles a group only when the amounts add up exactly", () => {
  const dues = [due("D1", "U-A", "2026-10-01", 120000), due("D2", "U-B", "2026-10-01", 130000)];
  const cls = [claim("C1", "U-A", "2026-10-02", 120000, { batch_ref: "B7" }), claim("C2", "U-B", "2026-10-02", 130000, { batch_ref: "B7" })];
  const ok = match({ due: dues, claims: cls, bank: [txn("T1", "2026-10-03", 250000, "cp-manager")], payers });
  assert.equal(out(ok, "T1"), "settles_batch");
  assert.deepEqual([st(ok, "D1").status, st(ok, "D2").status], ["paid_full", "paid_full"]);
  const off = match({ due: dues, claims: cls, bank: [txn("T1", "2026-10-03", 249000, "cp-manager")], payers });
  assert.equal(off.exceptions.batch_mismatch, 1);
  assert.deepEqual([st(off, "D1").status, st(off, "D2").status], ["unpaid", "unpaid"]);
  assert.equal(off.exceptions.claimed_not_settled, 2);
});

test("an explicit reversal cancels the credit: the due is unpaid again", () => {
  const r = match({ due: [due("D1", "U-A", "2026-10-01", 150000)], claims: [claim("C1", "U-A", "2026-10-01", 150000)], bank: [txn("T1", "2026-10-02", 150000, "cp-A"), txn("T2", "2026-10-09", -150000, "cp-A", "refund", { reversal_of: "T1" })], payers });
  assert.equal(out(r, "T1"), "reversed");
  assert.equal(st(r, "D1").status, "unpaid");
  assert.equal(r.claims[0].outcome, "claimed_not_settled");
});

test("a returned payment without reversal_of is caught as a probable reversal within 30 days", () => {
  const base = { due: [due("D1", "U-A", "2026-10-01", 150000)], claims: [claim("C1", "U-A", "2026-10-01", 150000)], payers };
  const r = match({ ...base, bank: [txn("T1", "2026-10-02", 150000, "cp-A"), txn("T2", "2026-10-20", -150000, "cp-A", "unknown")] });
  assert.equal(r.exceptions.probable_reversal, 1);
  assert.equal(st(r, "D1").status, "unpaid");
  const late = match({ ...base, bank: [txn("T1", "2026-10-02", 150000, "cp-A"), txn("T2", "2026-11-05", -150000, "cp-A", "unknown")] });
  assert.equal(late.exceptions.probable_reversal, 0);
  assert.equal(st(late, "D1").status, "paid_full");
});

test("a claim the manager itself reversed is not cash", () => {
  const r = match({ due: [due("D1", "U-A", "2026-10-01", 150000)], claims: [claim("C1", "U-A", "2026-10-01", 150000), claim("C1r", "U-A", "2026-10-05", 150000, { status: "reversed" })], bank: [], payers });
  assert.equal(r.claimed_cash_cents, 0);
  assert.equal(r.claims[0].outcome, "reversed_by_manager");
});

test("duplicate bank transactions and duplicate claims are dropped and counted", () => {
  const r = match({ due: [due("D1", "U-A", "2026-10-01", 150000)], claims: [claim("C1", "U-A", "2026-10-01", 150000), claim("C1-copy", "U-A", "2026-10-01", 150000)], bank: [txn("T1", "2026-10-02", 150000, "cp-A"), txn("T1", "2026-10-02", 150000, "cp-A")], payers });
  assert.equal(r.exceptions.duplicate_bank_txn, 1);
  assert.equal(r.exceptions.duplicate_claim, 1);
  assert.equal(r.claimed_cash_cents, 150000);
  assert.equal(st(r, "D1").settled_cents, 150000);
});

test("a deposit is not automatically rent: security deposits, owner transfers, loan proceeds and refunds are not income", () => {
  const r = match({
    due: [due("D1", "U-A", "2026-10-01", 150000)],
    claims: [claim("C1", "U-A", "2026-10-01", 150000)],
    bank: [txn("T1", "2026-10-02", 150000, "cp-new-tenant", "security_deposit"), txn("T2", "2026-10-02", 150000, "cp-sponsor", "owner_transfer"), txn("T3", "2026-10-02", 150000, "cp-lender", "loan_proceeds"), txn("T4", "2026-10-02", 150000, "cp-x", "refund")],
    payers,
  });
  assert.deepEqual(["T1", "T2", "T3", "T4"].map((id) => out(r, id)), ["security_deposit", "owner_transfer", "loan_proceeds", "refund"]);
  assert.equal(st(r, "D1").status, "unpaid");
  assert.equal(r.claims[0].outcome, "claimed_not_settled");
});

test("an unknown credit stays unattributed and is not matched to anyone's rent", () => {
  const r = match({ due: [due("D1", "U-A", "2026-10-01", 150000)], claims: [], bank: [txn("T1", "2026-10-02", 150000, "cp-unknown", "unknown")], payers });
  assert.equal(out(r, "T1"), "unattributed");
  assert.equal(st(r, "D1").status, "unpaid");
});

test("M5: an unclaimed credit from a mapped payer covers no open item, its own unit's or another's", () => {
  const r = match({ due: [due("D1", "U-A", "2026-10-01", 100000), due("D2", "U-B", "2026-10-01", 100000)], claims: [], bank: [txn("T1", "2026-10-02", 130000, "cp-A")], payers });
  assert.equal(st(r, "D1").status, "unpaid");
  assert.equal(st(r, "D1").settled_cents, 0);
  assert.equal(st(r, "D2").status, "unpaid");
  assert.equal(out(r, "T1"), "settled_not_claimed");
  assert.equal(r.bank[0].used_cents, 0);
  assert.equal(r.exceptions.settled_not_claimed, 1);
  assert.equal(r.exceptions.unapplied_credit, 0);
  assert.equal(r.amounts.unapplied_credit_cents, 0);
});

test("a claim with no matching due item is a claim_without_due and is not claimed cash", () => {
  const r = match({ due: [due("D1", "U-A", "2026-10-01", 100000)], claims: [claim("C1", "U-Z", "2026-10-01", 50000)], bank: [], payers });
  assert.equal(r.exceptions.claim_without_due, 1);
  assert.equal(r.claimed_cash_cents, 0);
});

test("a distribution within 10 days after an owner transfer counts as sponsor-funded", () => {
  const r = match({ due: [], claims: [], bank: [txn("T1", "2026-10-25", 500000, "cp-sponsor", "owner_transfer"), txn("T2", "2026-10-30", -800000, "cp-holders", "distribution")], payers });
  assert.equal(r.exceptions.distribution_funded_by_sponsor, 1);
  assert.equal(r.bank.find((t) => t.txn_id === "T2").funded_by_sponsor, true);
  const apart = match({ due: [], claims: [], bank: [txn("T1", "2026-10-01", 500000, "cp-sponsor", "owner_transfer"), txn("T2", "2026-10-30", -800000, "cp-holders", "distribution")], payers });
  assert.equal(apart.exceptions.distribution_funded_by_sponsor, 0);
});

test("the matcher is deterministic: input order does not change the result", () => {
  const input = {
    due: [due("D1", "U-A", "2026-10-01", 100000), due("D2", "U-B", "2026-10-01", 100000), due("D3", "U-C", "2026-10-01", 100000)],
    claims: [claim("C1", "U-A", "2026-10-01", 100000), claim("C2", "U-B", "2026-10-02", 100000), claim("C3", "U-C", "2026-10-03", 100000)],
    bank: [txn("T1", "2026-10-02", 100000, "cp-A"), txn("T2", "2026-10-02", 100000, "cp-B"), txn("T3", "2026-10-30", -50000, "cp-ops", "expense")],
    payers,
  };
  const a = match(input);
  const b = match({ due: [...input.due].reverse(), claims: [...input.claims].reverse(), bank: [...input.bank].reverse(), payers });
  assert.deepEqual(a, b);
  assert.equal(a.bank.find((t) => t.txn_id === "T3").outcome, "expense");
});

test("non-integer cents are refused", () => {
  assert.throws(() => match({ due: [], claims: [claim("C1", "U-A", "2026-10-01", 10.5)], bank: [], payers }), /integer cents/);
  assert.throws(() => match({ due: [], claims: [], bank: [txn("T1", "2026-10-01", 1e17, "cp-A")], payers }), /integer cents/);
});

test("a security deposit from the tenant's own payer never marks rent paid: with a manager claim", () => {
  const r = match({ due: [due("D1", "U-A", "2026-10-01", 150000)], claims: [claim("C1", "U-A", "2026-10-01", 150000)], bank: [txn("T1", "2026-10-02", 150000, "cp-A", "security_deposit")], payers });
  assert.equal(st(r, "D1").status, "unpaid");
  assert.equal(r.claims[0].outcome, "claimed_not_settled");
  assert.equal(out(r, "T1"), "security_deposit");
  assert.equal(r.bank[0].used_cents, 0);
});

test("a security deposit from the tenant's own payer never marks rent paid: without a manager claim", () => {
  const r = match({ due: [due("D1", "U-A", "2026-10-01", 150000)], claims: [], bank: [txn("T1", "2026-10-02", 150000, "cp-A", "security_deposit")], payers });
  assert.equal(st(r, "D1").status, "unpaid");
  assert.equal(r.exceptions.settled_not_claimed, 0);
  assert.equal(out(r, "T1"), "security_deposit");
});

test("owner transfers, loan proceeds and refunds from a mapped payer settle nothing either", () => {
  for (const kind of ["owner_transfer", "loan_proceeds", "refund"]) {
    const r = match({ due: [due("D1", "U-A", "2026-10-01", 150000)], claims: [claim("C1", "U-A", "2026-10-01", 150000)], bank: [txn("T1", "2026-10-02", 150000, "cp-A", kind)], payers });
    assert.equal(st(r, "D1").status, "unpaid", kind);
    assert.equal(out(r, "T1"), kind, kind);
  }
});
