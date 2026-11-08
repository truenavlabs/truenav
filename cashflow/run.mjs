// One run of the cashflow-v2.0.0 method on one fund or token: adapters, three-way match, metrics, score, and the
// evidence passport. This is the JS reference the Rust/WASM build in OutLayer must match (spec section 10). In the
// TEE, the bank feed is fetched by the module itself from the mock bank-data API with sealed credentials and the
// pseudonym key is OutLayer's derived key; here both are parameters.
import { createHash } from "node:crypto";
import { match } from "./match.mjs";
import { metrics, scoreInput, publicMetrics } from "./metrics.mjs";
import { settledFromFeed } from "./adapters/bank.mjs";
import { fromServicerTape } from "./adapters/credit.mjs";
import { fromManagerExport } from "./adapters/rental.mjs";
import { score, METHOD, sourceFreshnessBps } from "../spec/v2/score.mjs";

const sha = (x) => createHash("sha256").update(typeof x === "string" ? x : JSON.stringify(x)).digest("hex");
const hoursBetween = (fromIso, toIso) => Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 3600000));

/**
 * ds: a dataset (cashflow/demo/data.mjs shape). key: pseudonym key. asOf: run time (ISO date or timestamp).
 * bankFetchedAt: when the TEE fetched the bank feed (defaults to asOf). previous: { [source]: snapshot_sha256 } of
 * the previous run, for the carried-forward rule; newPeriod: whether a new period started since that run.
 */
export function runFund(ds, { key, asOf, period, daysInPeriod, bankFetchedAt = asOf, previous = {}, newPeriod = false }) {
  const bank = settledFromFeed(ds.bank_feed, key);
  const isCredit = ds.kind === "credit";
  const src = isCredit ? fromServicerTape(ds.servicer_tape, key) : fromManagerExport(ds.manager_export, key);
  const m = match({ due: src.due, claims: src.claims, bank, payers: src.payers });
  const issuer = isCredit ? ds.issuer : { ...ds.issuer, occupancy_bps: ds.issuer.occupancy_bps };
  const mt = metrics({ kind: ds.kind, m, issuer, units: src.units || {}, asOf: asOf.slice(0, 10), period, daysInPeriod });

  const managerExport = isCredit ? ds.servicer_tape : ds.manager_export;
  const snap = { bank_settlements: sha(ds.bank_feed), [isCredit ? "servicer_records" : "property_manager_records"]: sha(managerExport), issuer_claims: sha(ds.issuer) };
  const carried = (name) => newPeriod && previous[name] === snap[name];
  const sources = [
    { source: "bank_settlements", tier: 3, independence: "third_party_bank", cadence: "daily", age_hours: hoursBetween(bankFetchedAt, asOf), carried_forward: carried("bank_settlements"), snapshot_sha256: snap.bank_settlements, synthetic: !!ds.bank_feed.synthetic },
    { source: isCredit ? "servicer_records" : "property_manager_records", tier: 2, independence: "issuer_appointed_manager", cadence: "monthly", age_hours: hoursBetween(`${managerExport.as_of}T00:00:00Z`, asOf), carried_forward: carried(isCredit ? "servicer_records" : "property_manager_records"), snapshot_sha256: snap[isCredit ? "servicer_records" : "property_manager_records"], synthetic: !!ds.synthetic },
    { source: "issuer_claims", tier: 1, independence: "issuer", cadence: "monthly", age_hours: hoursBetween(`${managerExport.as_of}T00:00:00Z`, asOf), carried_forward: false, required: false, snapshot_sha256: snap.issuer_claims, synthetic: !!ds.synthetic },
  ];
  const s = score(scoreInput(mt, sources));
  const passport = sources.map((x) => ({ ...x, freshness_bps: sourceFreshnessBps(x), method_version: METHOD }));
  return { token_id: ds.id, kind: ds.kind, method: METHOD, match: m, metrics: mt, public_metrics: publicMetrics(mt), passport, score: s };
}
