// TrueNav cashflow-v2.0.0 three-way match (spec/v2/SPEC.md section 4, rules M1 to M6), JS reference.
// Inputs, all integer cents and ISO dates (UTC), all identifiers pseudonymous:
//   due      [{ due_id, kind, unit_ref, component, due_date, amount_due_cents, period }]
//   claims   [{ claim_id, due_id|null, unit_ref, paid_date, amount_cents, status: paid|partial|reversed, batch_ref|null }]
//   bank     [{ txn_id, posted_date, amount_cents (credits > 0), counterparty_ref, kind_hint, reversal_of|null }]
//   payers   { counterparty_ref: unit_ref }   which bank counterparty pays which unit (from the manager export)
// Output: per due item status and settled cents, per claim outcome, per bank credit outcome, exception counts.
// The matcher never invents a match: whatever it cannot tie is reported as a gap. Deterministic: inputs are
// processed in a fixed order (dates, then ids), so the Rust port can match it exactly.

export const SETTLE_WINDOW = { before: 2, after: 5 }; // posted_date - paid_date, in days (M3)
export const REVERSAL_WINDOW_DAYS = 30; // M1 probable reversal
export const SPONSOR_WINDOW_DAYS = 10; // M5: owner transfer this many days or fewer before a distribution
export const EXCEPTIONS = [
  "claimed_not_settled", "settled_not_claimed", "duplicate_claim", "duplicate_bank_txn", "probable_reversal",
  "batch_mismatch", "claim_without_due", "unapplied_credit", "distribution_funded_by_sponsor",
];
const NOT_INCOME = new Set(["security_deposit", "owner_transfer", "loan_proceeds", "refund"]);

const DAY = 86400000;
export function days(iso) {
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || !Number.isFinite(t)) throw new Error(`bad date ${iso}`);
  return Math.round(t / DAY);
}
const cents = (x, what) => {
  if (!Number.isSafeInteger(x)) throw new Error(`${what} must be integer cents`);
  return x;
};
const byDateThenId = (dateKey, idKey) => (a, b) => days(a[dateKey]) - days(b[dateKey]) || String(a[idKey]).localeCompare(String(b[idKey]));

export function match({ due, claims, bank, payers = {} }) {
  const exceptions = Object.fromEntries(EXCEPTIONS.map((e) => [e, 0]));
  const amounts = { claimed_not_settled_cents: 0, unapplied_credit_cents: 0 };

  // ---- M1 normalize --------------------------------------------------------------------------------------
  const seenTxn = new Set();
  const txns = [];
  for (const t of [...bank].sort(byDateThenId("posted_date", "txn_id"))) {
    cents(t.amount_cents, "amount_cents");
    if (seenTxn.has(t.txn_id)) {
      exceptions.duplicate_bank_txn++;
      continue;
    }
    seenTxn.add(t.txn_id);
    txns.push({ ...t, reversed: false, used: 0, outcome: null });
  }
  const credits = txns.filter((t) => t.amount_cents > 0);
  const debits = txns.filter((t) => t.amount_cents < 0);
  for (const d of debits) {
    if (d.reversal_of) {
      const c = credits.find((x) => x.txn_id === d.reversal_of && !x.reversed);
      if (c) {
        c.reversed = true;
        c.outcome = "reversed";
        d.outcome = "reversal";
      }
    }
  }
  for (const d of debits) {
    if (d.outcome || d.kind_hint === "distribution" || d.kind_hint === "expense") continue;
    const c = credits.find(
      (x) => !x.reversed && x.counterparty_ref === d.counterparty_ref && x.amount_cents === -d.amount_cents && days(d.posted_date) - days(x.posted_date) >= 0 && days(d.posted_date) - days(x.posted_date) <= REVERSAL_WINDOW_DAYS,
    );
    if (c) {
      c.reversed = true;
      c.outcome = "reversed";
      d.outcome = "reversal";
      exceptions.probable_reversal++;
    }
  }

  const seenClaim = new Set();
  let cl = [];
  for (const c of [...claims].sort(byDateThenId("paid_date", "claim_id"))) {
    cents(c.amount_cents, "amount_cents");
    const key = `${c.unit_ref}|${c.paid_date}|${c.amount_cents}|${c.status}`;
    if (seenClaim.has(key)) {
      exceptions.duplicate_claim++;
      continue;
    }
    seenClaim.add(key);
    cl.push({ ...c, linked_due: null, settled_by: null, outcome: null });
  }
  // A reversed claim cancels the earliest paid claim of the same unit and amount.
  for (const r of cl.filter((c) => c.status === "reversed")) {
    const p = cl.find((c) => c.status !== "reversed" && !c.outcome && c.unit_ref === r.unit_ref && c.amount_cents === r.amount_cents && days(c.paid_date) <= days(r.paid_date));
    if (p) p.outcome = "reversed_by_manager";
    r.outcome = "reversal_record";
  }
  cl = cl.filter((c) => c.status !== "reversed");
  const live = cl.filter((c) => c.outcome !== "reversed_by_manager");

  // ---- M2 claim to due -----------------------------------------------------------------------------------
  const dues = [...due].sort(byDateThenId("due_date", "due_id")).map((d) => ({ ...d, claimed: 0, settled: 0, status: "unpaid" }));
  const dueById = new Map(dues.map((d) => [d.due_id, d]));
  for (const c of live) {
    let d = c.due_id ? dueById.get(c.due_id) : null;
    if (d && d.unit_ref !== c.unit_ref) d = null;
    if (!d && !c.due_id) d = dues.find((x) => x.unit_ref === c.unit_ref && x.amount_due_cents - x.claimed >= c.amount_cents);
    if (!d) {
      c.outcome = "claim_without_due";
      exceptions.claim_without_due++;
      continue;
    }
    c.linked_due = d.due_id;
    d.claimed += c.amount_cents;
  }

  // ---- M3 claim to bank ----------------------------------------------------------------------------------
  const inWindow = (paid, posted) => {
    const diff = days(posted) - days(paid);
    return diff >= -SETTLE_WINDOW.before && diff <= SETTLE_WINDOW.after;
  };
  const free = (t) => !t.reversed && t.used === 0;
  // single settlements: same payer (mapped to the unit), same amount, inside the window
  for (const c of live.filter((x) => x.linked_due)) {
    const t = credits.find((x) => free(x) && payers[x.counterparty_ref] === c.unit_ref && x.amount_cents === c.amount_cents && inWindow(c.paid_date, x.posted_date));
    if (t) {
      t.used = t.amount_cents;
      t.outcome = "settles_claim";
      c.settled_by = t.txn_id;
    }
  }
  // batched deposits: one credit from a counterparty that pays no single unit settles a group of claims sharing
  // batch_ref (or paid_date) only when the amounts add up exactly
  const groups = new Map();
  for (const c of live.filter((x) => x.linked_due && !x.settled_by)) {
    const k = c.batch_ref || `date:${c.paid_date}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  for (const [, g] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const sum = g.reduce((s, c) => s + c.amount_cents, 0);
    const paid = g.map((c) => c.paid_date).sort()[0];
    const candidates = credits.filter((x) => free(x) && !payers[x.counterparty_ref] && !NOT_INCOME.has(x.kind_hint) && inWindow(paid, x.posted_date));
    const exact = candidates.find((x) => x.amount_cents === sum);
    if (exact && g.length > 1) {
      exact.used = sum;
      exact.outcome = "settles_batch";
      for (const c of g) c.settled_by = exact.txn_id;
    } else if (g.length > 1 && candidates.some((x) => x.kind_hint === "rent" || x.kind_hint === "loan_payment")) {
      exceptions.batch_mismatch++;
    }
  }

  // ---- M4 partials, unpaid, cash the manager did not record -----------------------------------------------
  for (const c of live) {
    if (c.settled_by) {
      dueById.get(c.linked_due).settled += c.amount_cents;
      c.outcome = c.outcome || "settled";
    } else if (!c.outcome) {
      c.outcome = "claimed_not_settled";
      exceptions.claimed_not_settled++;
      amounts.claimed_not_settled_cents += c.amount_cents;
    }
  }
  // a credit from a unit's own payer that settles no claim: the bank shows cash the manager did not record. It is
  // applied to that unit's oldest open due items; anything beyond them is an unapplied credit, never income for
  // another unit.
  for (const t of credits.filter((x) => free(x) && payers[x.counterparty_ref])) {
    let left = t.amount_cents;
    for (const d of dues.filter((x) => x.unit_ref === payers[t.counterparty_ref])) {
      const open = d.amount_due_cents - d.settled;
      if (open <= 0 || left <= 0) continue;
      const take = Math.min(open, left);
      d.settled += take;
      left -= take;
    }
    t.used = t.amount_cents - left;
    t.outcome = t.used > 0 ? "settled_not_claimed" : "unapplied_credit";
    if (t.used > 0) exceptions.settled_not_claimed++;
    if (left > 0) {
      exceptions.unapplied_credit++;
      amounts.unapplied_credit_cents += left;
    }
  }
  for (const d of dues) d.status = d.settled >= d.amount_due_cents ? "paid_full" : d.settled > 0 ? "paid_partial" : "unpaid";

  // ---- M5 classify bank credits that settle nothing -------------------------------------------------------
  for (const t of credits.filter((x) => !x.reversed && x.used === 0 && !x.outcome)) {
    t.outcome = NOT_INCOME.has(t.kind_hint) ? t.kind_hint : "unattributed";
  }
  const distributions = debits.filter((d) => d.kind_hint === "distribution" && !d.outcome);
  for (const dist of distributions) {
    const funded = credits.some((c) => c.outcome === "owner_transfer" && days(dist.posted_date) - days(c.posted_date) >= 0 && days(dist.posted_date) - days(c.posted_date) <= SPONSOR_WINDOW_DAYS);
    if (funded) exceptions.distribution_funded_by_sponsor++;
  }

  return {
    due: dues.map(({ due_id, unit_ref, component, period, due_date, amount_due_cents, settled, status }) => ({ due_id, unit_ref, component, period, due_date, amount_due_cents, settled_cents: settled, status })),
    claims: cl.map(({ claim_id, unit_ref, amount_cents, linked_due, settled_by, outcome }) => ({ claim_id, unit_ref, amount_cents, linked_due, settled_by, outcome })),
    bank: txns.map(({ txn_id, amount_cents, kind_hint, used, outcome }) => ({ txn_id, amount_cents, kind_hint, used_cents: used, outcome: outcome || (amount_cents < 0 ? kind_hint : "unattributed") })),
    exceptions,
    amounts,
    claimed_cash_cents: live.filter((c) => c.outcome !== "claim_without_due").reduce((s, c) => s + c.amount_cents, 0),
    distributions_cents: -distributions.reduce((s, d) => s + d.amount_cents, 0),
    expenses_cents: -debits.filter((d) => d.kind_hint === "expense" && !d.outcome).reduce((s, d) => s + d.amount_cents, 0),
  };
}
