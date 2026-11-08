// Writes cashflow/fixtures/edge/cashflow-edge-cases.json: small synthetic edge cases that the Rust/WASM build must
// reproduce exactly, next to the four fund fixtures. Each case is raw input plus either the reference output as
// canonical JSON bytes or the named fail-closed code. Regenerate only on a method change:
//   node cashflow/fixtures/make-edge.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { datasets } from "../demo/data.mjs";
import { runFund, RunError } from "../run.mjs";
import { METHOD } from "../../spec/v2/score.mjs";
import { canonical } from "./canonical.mjs";
import { PARITY_OPTIONS, PARITY_PSEUDONYM_SEED } from "./make-parity.mjs";

const fund = (id) => datasets().find((d) => d.id === id);
const edit = (id, f) => {
  const d = fund(id);
  f(d);
  return d;
};
// M5: one rent due of 100 cents in October, no manager claim, one rent credit from the unit's own (mapped) tenant.
// September is paid and bank-settled, so the v2.1.0 collection check (September, as of 2026-11-01) is verified.
const m5 = {
  id: "EDGE-M5", name: "Edge case M5 (synthetic)", kind: "rental", synthetic: true,
  manager_export: {
    as_of: "2026-10-31",
    units: [{ unit_id: "EDGE-M5-U00", occupied: true, tenant_payer: "Tenant EDGE-M5 00", rent_cents: 100 }],
    charges: [{ unit_id: "EDGE-M5-U00", due_date: "2026-09-01", amount_cents: 100 }, { unit_id: "EDGE-M5-U00", due_date: "2026-10-01", amount_cents: 100 }],
    ledger: [{ entry_id: "EDGE-M5-U00-2026-09", unit_id: "EDGE-M5-U00", paid_date: "2026-09-02", amount_cents: 100, status: "paid", batch_ref: null }],
  },
  bank_feed: { synthetic: true, account_id: "EDGE-M5-operating", transactions: [
    { transaction_id: "bk-EDGE-M5-0", date: "2026-09-03", amount_cents: -100, counterparty: "Tenant EDGE-M5 00", category: "RENT", pending: false },
    { transaction_id: "bk-EDGE-M5-1", date: "2026-10-02", amount_cents: -100, counterparty: "Tenant EDGE-M5 00", category: "RENT", pending: false },
  ] },
  issuer: { token_id: "EDGE-M5", as_of: "2026-10-31", period: "2026-10", occupancy_bps: 10000, expenses_cents: 0, reserves_cents: 0, distributions_paid_cents: 0 },
};
// cashflow-v2.1.0 collection (spec 5.7): one-fund rental datasets checked for October, as of 2026-11-08.
const AFTER = "2026-11-08T00:00:00Z";
function coll(id, units, { asOf = AFTER, exportAsOf = AFTER } = {}) {
  const u = units.map((x, i) => ({ unit_id: `${id}-U${i}`, occupied: x.occupied !== false, tenant_payer: `Tenant ${id} ${i}`, rent_cents: x.rent }));
  const charges = units.flatMap((x, i) => (x.occupied === false ? [] : [{ unit_id: `${id}-U${i}`, due_date: "2026-10-01", amount_cents: x.rent, ...(x.extra || {}) }]));
  const ledger = [];
  const transactions = [];
  units.forEach((x, i) =>
    (x.paid || []).forEach(([paid, amt, posted], j) => {
      if (paid) ledger.push({ entry_id: `${id}-U${i}-${j}`, unit_id: `${id}-U${i}`, paid_date: paid, amount_cents: amt, status: "paid", batch_ref: null });
      transactions.push({ transaction_id: `bk-${id}-U${i}-${j}`, date: posted, amount_cents: -amt, counterparty: `Tenant ${id} ${i}`, category: "RENT", pending: false });
    }),
  );
  const dataset = {
    id, name: `${id} (synthetic)`, kind: "rental", synthetic: true,
    manager_export: { as_of: exportAsOf, units: u, charges, ledger },
    bank_feed: { synthetic: true, account_id: `${id}-operating`, transactions },
    issuer: { token_id: id, as_of: exportAsOf, period: "2026-10", occupancy_bps: 10000, expenses_cents: 0, reserves_cents: 0, distributions_paid_cents: 0 },
  };
  return [dataset, { ...PARITY_OPTIONS, asOf, bankFetchedAt: asOf }];
}
const mut = ([d, o], f) => {
  f(d);
  return [d, o];
};
const paid = (amt) => [["2026-10-02", amt, "2026-10-03"]];

const plus7 = { ...PARITY_OPTIONS, asOf: "2026-11-01T07:00:00+07:00", bankFetchedAt: "2026-11-01T05:00:00+07:00" };

export const CASES = [
  ["m5_mapped_payer_credit_without_claim", m5, PARITY_OPTIONS],
  ["utc_run_and_fetch_time_given_as_plus_0700", fund("DEMO-CREDIT"), plus7],
  ["utc_document_as_of_with_offsets", edit("DEMO-RENTAL", (d) => { d.issuer.as_of = "2026-10-31T07:00:00+07:00"; d.manager_export.as_of = "2026-10-30T19:00:00-05:00"; }), PARITY_OPTIONS],
  ["issuer_as_of_null", edit("DEMO-RENTAL", (d) => { d.issuer.as_of = null; }), PARITY_OPTIONS],
  ["issuer_as_of_missing", edit("DEMO-RENTAL", (d) => { delete d.issuer.as_of; }), PARITY_OPTIONS],
  ["issuer_as_of_not_a_timestamp", edit("DEMO-RENTAL", (d) => { d.issuer.as_of = "31/10/2026"; }), PARITY_OPTIONS],
  ["issuer_as_of_a_number", edit("DEMO-RENTAL", (d) => { d.issuer.as_of = 20261031; }), PARITY_OPTIONS],
  ["servicer_as_of_null", edit("DEMO-CREDIT", (d) => { d.servicer_tape.as_of = null; }), PARITY_OPTIONS],
  ["manager_as_of_offset_without_colon", edit("DEMO-RENTAL", (d) => { d.manager_export.as_of = "2026-10-31T00:00:00+0700"; }), PARITY_OPTIONS],
  ["bank_feed_missing", edit("DEMO-CREDIT", (d) => { d.bank_feed = null; }), PARITY_OPTIONS],
  ["manager_export_missing", edit("DEMO-RENTAL", (d) => { delete d.manager_export; }), PARITY_OPTIONS],
  ["issuer_missing", edit("HONEST-CREDIT", (d) => { d.issuer = []; }), PARITY_OPTIONS],
  ["run_as_of_without_zone", fund("HONEST-RENTAL"), { ...PARITY_OPTIONS, asOf: "2026-11-01T00:00:00" }],
  ["bank_fetch_time_invalid", fund("HONEST-RENTAL"), { ...PARITY_OPTIONS, bankFetchedAt: "2026-10-31T24:00:00Z" }],
  ["collection_gap_one_unit_100_cents", ...coll("COLL-GAP", [{ rent: 100 }])],
  ["collection_exactly_90_percent", ...coll("COLL-90", [{ rent: 10000, paid: paid(9000) }])],
  ["collection_89_99_percent", ...coll("COLL-8999", [{ rent: 10000, paid: paid(8999) }])],
  ["collection_rounds_to_90_but_below", ...coll("COLL-ROUND", [{ rent: 10000000, paid: paid(8999999) }])],
  ["collection_settled_after_cutoff", ...coll("COLL-LATE", [{ rent: 100, paid: [["2026-11-06", 100, "2026-11-08"]] }])],
  ["collection_written_off_due_still_counts", ...coll("COLL-WO", [{ rent: 100, extra: { written_off: true, status: "written_off" } }, { rent: 100, paid: paid(100) }])],
  ["collection_zero_dues_not_applicable", ...coll("COLL-ZERO", [{ rent: 100, occupied: false }])],
  ["collection_pending_before_cutoff", ...coll("COLL-EARLY", [{ rent: 100 }], { asOf: "2026-10-05T00:00:00Z", exportAsOf: "2026-10-05T00:00:00Z" })],
  ["collection_pending_no_manager_coverage", ...coll("COLL-STALE", [{ rent: 100, paid: paid(100) }], { exportAsOf: "2026-11-05T00:00:00Z" })],
  ["collection_dues_missing", ...mut(coll("COLL-MISS", [{ rent: 100 }]), (d) => delete d.manager_export.charges)],
  ["collection_dues_row_incomplete", ...mut(coll("COLL-ROW", [{ rent: 100 }]), (d) => delete d.manager_export.charges[0].amount_cents)],
  ["collection_occupied_unit_without_due", ...mut(coll("COLL-NODUE", [{ rent: 100 }]), (d) => (d.manager_export.charges = []))],
  ["collection_credit_loan_schedule_missing", ...mut([fund("HONEST-CREDIT"), PARITY_OPTIONS], (d) => (d.servicer_tape.schedule = null))],
  // fields that reach public_metrics: fixed type and range, fixed codes (owner review 8 Nov)
  ["occupancy_bps_string", edit("HONEST-RENTAL", (d) => { d.issuer.occupancy_bps = "SENTINEL-not-a-number"; }), PARITY_OPTIONS],
  ["occupancy_bps_float", edit("HONEST-RENTAL", (d) => { d.issuer.occupancy_bps = 9583.5; }), PARITY_OPTIONS],
  ["occupancy_bps_negative", edit("HONEST-RENTAL", (d) => { d.issuer.occupancy_bps = -1; }), PARITY_OPTIONS],
  ["occupancy_bps_above_10000", edit("HONEST-RENTAL", (d) => { d.issuer.occupancy_bps = 10001; }), PARITY_OPTIONS],
  ["occupancy_bps_missing", edit("HONEST-RENTAL", (d) => { delete d.issuer.occupancy_bps; }), PARITY_OPTIONS],
  ["occupancy_bps_valid_10000", edit("HONEST-RENTAL", (d) => { d.issuer.occupancy_bps = 10000; }), PARITY_OPTIONS],
  ["reported_yield_bps_string", edit("HONEST-CREDIT", (d) => { d.issuer.reported_yield_bps = "11%"; }), PARITY_OPTIONS],
  ["principal_outstanding_negative", edit("HONEST-CREDIT", (d) => { d.issuer.principal_outstanding_cents = -1; }), PARITY_OPTIONS],
  ["accrued_interest_float", edit("HONEST-CREDIT", (d) => { d.issuer.accrued_interest_cents = 0.5; }), PARITY_OPTIONS],
  ["expenses_string", edit("HONEST-RENTAL", (d) => { d.issuer.expenses_cents = "1000"; }), PARITY_OPTIONS],
  ["distributions_null_allowed", edit("HONEST-RENTAL", (d) => { d.issuer.distributions_paid_cents = null; }), PARITY_OPTIONS],
  ["roster_rent_string", edit("HONEST-RENTAL", (d) => { d.manager_export.units[0].rent_cents = "200000"; }), PARITY_OPTIONS],
  ["roster_occupied_string", edit("HONEST-RENTAL", (d) => { d.manager_export.units[0].occupied = "yes"; }), PARITY_OPTIONS],
  ["claim_amount_negative", edit("HONEST-CREDIT", (d) => { d.servicer_tape.payments[0].amount_cents = -1; }), PARITY_OPTIONS],
  ["bank_amount_float", edit("DEMO-RENTAL", (d) => { d.bank_feed.transactions[0].amount_cents = 1.25; }), PARITY_OPTIONS],
];

export function edgeExpected(ds, options) {
  try {
    const r = runFund(ds, { key: PARITY_PSEUDONYM_SEED, ...options });
    return { output: canonical({ token_id: r.token_id, kind: r.kind, method: r.method, match: r.match, metrics: r.metrics, public_metrics: r.public_metrics, passport: r.passport, score: r.score }) };
  } catch (e) {
    if (e instanceof RunError) return { error: e.code };
    throw e;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = new URL("./edge/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  const cases = CASES.map(([name, dataset, options]) => ({ name, input: { dataset, options, pseudonym_seed: PARITY_PSEUDONYM_SEED }, expected: edgeExpected(dataset, options) }));
  const file = { name: "cashflow-edge-cases", method: METHOD, note: "Synthetic edge cases. The Rust/WASM build must give exactly expected.output (canonical JSON bytes) or fail with expected.error.", cases };
  writeFileSync(new URL("cashflow-edge-cases.json", dir), JSON.stringify(file, null, 1) + "\n");
  for (const c of cases) console.log(c.name, c.expected.error ? `error ${c.expected.error}` : `output ${c.expected.output.length} bytes`);
}
