// Property-manager export (rent roll plus ledger) to the shared schema (spec/v2/SPEC.md section 3). Format (synthetic):
//   { as_of, units: [{ unit_id, occupied, tenant_payer|null, rent_cents }], charges: [{ unit_id, due_date,
//     amount_cents }], ledger: [{ entry_id, unit_id, paid_date, amount_cents, status, batch_ref }] }
// Occupancy comes from the rent roll and is reported as is; it is never used as collection.
import { unitRef, payerRef } from "../pseudo.mjs";

export function fromManagerExport(exp, key) {
  const due = exp.charges.map((c, i) => ({
    due_id: `rent-${i}`,
    kind: "lease",
    unit_ref: unitRef(key, c.unit_id),
    component: "rent",
    due_date: c.due_date,
    amount_due_cents: c.amount_cents,
    period: c.due_date.slice(0, 7),
  }));
  const claims = exp.ledger.map((e) => ({
    claim_id: String(e.entry_id),
    due_id: null,
    unit_ref: unitRef(key, e.unit_id),
    paid_date: e.paid_date,
    amount_cents: e.amount_cents,
    status: e.status || "paid",
    batch_ref: e.batch_ref || null,
  }));
  const payers = Object.fromEntries(exp.units.filter((u) => u.tenant_payer).map((u) => [payerRef(key, u.tenant_payer), unitRef(key, u.unit_id)]));
  const occupied = exp.units.filter((u) => u.occupied).length;
  return { due, claims, payers, occupancy_bps: exp.units.length ? Math.round((10000 * occupied) / exp.units.length) : 0 };
}
