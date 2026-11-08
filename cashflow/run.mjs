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
 * bankFetchedAt: when the TEE fetched the bank feed (defaults to asOf). previous: { [source]: { snapshot_sha256,
 * as_of } } from the previous run's passport, for the carried-forward rule; newPeriod: whether a new period started.
 */
export function runFund(ds, { key, asOf, period, daysInPeriod, bankFetchedAt = asOf, previous = {}, newPeriod = false }) {
  const bank = settledFromFeed(ds.bank_feed, key);
  const isCredit = ds.kind === "credit";
  const src = isCredit ? fromServicerTape(ds.servicer_tape, key) : fromManagerExport(ds.manager_export, key);
  const m = match({ due: src.due, claims: src.claims, bank, payers: src.payers });
  const issuer = isCredit ? ds.issuer : { ...ds.issuer, occupancy_bps: ds.issuer.occupancy_bps };
  const mt = metrics({ kind: ds.kind, m, issuer, units: src.units || {}, asOf: asOf.slice(0, 10), period, daysInPeriod });

  // Freshness per source from that source's own as-of (spec 5.6): the TEE's fetch time for the bank feed, the
  // export timestamp for the manager file, the issuer's own as_of for its claims. carried_forward, per source, once
  // a new period has started: the same snapshot hash as the previous run, or an as-of that did not advance.
  const managerExport = isCredit ? ds.servicer_tape : ds.manager_export;
  const mgrName = isCredit ? "servicer_records" : "property_manager_records";
  const asOfOf = (x) => (x.length === 10 ? `${x}T00:00:00Z` : x);
  const raw = [
    { source: "bank_settlements", tier: 3, independence: "third_party_bank", cadence: "daily", as_of: asOfOf(bankFetchedAt), bytes: ds.bank_feed, synthetic: !!ds.bank_feed.synthetic },
    { source: mgrName, tier: 2, independence: "issuer_appointed_manager", cadence: "monthly", as_of: asOfOf(managerExport.as_of), bytes: managerExport, synthetic: !!ds.synthetic },
    { source: "issuer_claims", tier: 1, independence: "issuer", cadence: "monthly", as_of: asOfOf(ds.issuer.as_of), bytes: ds.issuer, synthetic: !!ds.synthetic },
  ];
  const sources = raw.map(({ bytes, ...x }) => {
    const snapshot_sha256 = sha(bytes);
    const prev = previous[x.source];
    const carried_forward = !!(newPeriod && prev && (prev.snapshot_sha256 === snapshot_sha256 || !(Date.parse(x.as_of) > Date.parse(prev.as_of))));
    return { ...x, age_hours: hoursBetween(x.as_of, asOf), carried_forward, snapshot_sha256 };
  });
  const s = score(scoreInput(mt, sources));
  const passport = sources.map((x) => ({ ...x, freshness_bps: sourceFreshnessBps(x), method_version: METHOD }));
  return { token_id: ds.id, kind: ds.kind, method: METHOD, match: m, metrics: mt, public_metrics: publicMetrics(mt), passport, score: s };
}
