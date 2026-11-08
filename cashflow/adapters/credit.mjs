// Servicer loan-tape export to the shared schema (spec/v2/SPEC.md section 3). Export format (synthetic):
//   { as_of, loans: [{ loan_id, borrower_payer, principal_cents, rate_bps, pay_type: "cash"|"pik" }],
//     schedule: [{ loan_id, due_date, component, amount_cents }], payments: [{ payment_id, loan_id, paid_date,
//     amount_cents, status, batch_ref }] }
// PIK loans have no cash interest due: their interest is capitalized and reported next to cash, never as cash.
import { unitRef, payerRef } from "../pseudo.mjs";

export function fromServicerTape(tape, key) {
  const due = tape.schedule.map((s, i) => ({
    due_id: `due-${i}`,
    kind: "loan",
    unit_ref: unitRef(key, s.loan_id),
    component: s.component,
    due_date: s.due_date,
    amount_due_cents: s.amount_cents,
    period: s.due_date.slice(0, 7),
  }));
  const claims = tape.payments.map((p) => ({
    claim_id: String(p.payment_id),
    due_id: null,
    unit_ref: unitRef(key, p.loan_id),
    paid_date: p.paid_date,
    amount_cents: p.amount_cents,
    status: p.status || "paid",
    batch_ref: p.batch_ref || null,
  }));
  const payers = Object.fromEntries(tape.loans.map((l) => [payerRef(key, l.borrower_payer), unitRef(key, l.loan_id)]));
  const units = Object.fromEntries(tape.loans.map((l) => [unitRef(key, l.loan_id), { principal_outstanding_cents: l.principal_cents }]));
  // every cash-pay loan must have a scheduled due in a verified collection period (PIK loans have no cash due)
  const active_units = tape.loans.filter((l) => l.pay_type !== "pik").map((l) => unitRef(key, l.loan_id));
  return { due, claims, payers, units, active_units };
}
