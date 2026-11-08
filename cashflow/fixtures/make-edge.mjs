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
// M5: one rent due of 100 cents, no manager claim, one rent credit from the unit's own (mapped) tenant.
const m5 = {
  id: "EDGE-M5", name: "Edge case M5 (synthetic)", kind: "rental", synthetic: true,
  manager_export: {
    as_of: "2026-10-31",
    units: [{ unit_id: "EDGE-M5-U00", occupied: true, tenant_payer: "Tenant EDGE-M5 00", rent_cents: 100 }],
    charges: [{ unit_id: "EDGE-M5-U00", due_date: "2026-10-01", amount_cents: 100 }],
    ledger: [],
  },
  bank_feed: { synthetic: true, account_id: "EDGE-M5-operating", transactions: [{ transaction_id: "bk-EDGE-M5-1", date: "2026-10-02", amount_cents: -100, counterparty: "Tenant EDGE-M5 00", category: "RENT", pending: false }] },
  issuer: { token_id: "EDGE-M5", as_of: "2026-10-31", period: "2026-10", occupancy_bps: 10000, expenses_cents: 0, reserves_cents: 0, distributions_paid_cents: 0 },
};
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
