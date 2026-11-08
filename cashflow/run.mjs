// One run of the cashflow-v2.1.0 method on one fund or token: adapters, three-way match, metrics, score, and the
// evidence passport. This is the JS reference the Rust/WASM build in OutLayer must match (spec section 10). In the
// TEE, the bank feed is fetched by the module itself from the mock bank-data API with sealed credentials and the
// pseudonym key is OutLayer's derived key; here both are parameters.
import { createHash } from "node:crypto";
import { match } from "./match.mjs";
import { metrics, scoreInput, publicMetrics, collection } from "./metrics.mjs";
import { settledFromFeed } from "./adapters/bank.mjs";
import { fromServicerTape } from "./adapters/credit.mjs";
import { fromManagerExport } from "./adapters/rental.mjs";
import { score, METHOD, sourceFreshnessBps } from "../spec/v2/score.mjs";

/** A run that cannot be scored fails closed with a fixed code (the TEE prints only this code as its stage). */
export class RunError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/**
 * Every timestamp is normalized to UTC before a date is taken from it. Accepted: an ISO date (YYYY-MM-DD, read as
 * midnight UTC) or YYYY-MM-DDTHH:MM:SS[.mmm] with Z or a +HH:MM / -HH:MM offset. Returned as
 * YYYY-MM-DDTHH:MM:SS[.mmm]Z (milliseconds only when not zero). Anything else is null.
 */
export function toUtc(x) {
  if (typeof x !== "string") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(x)) x = `${x}T00:00:00Z`;
  const m = x.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?(Z|([+-])(\d{2}):(\d{2}))$/);
  if (!m) return null;
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number);
  const ms = m[7] ? Number(m[7]) : 0;
  const off = m[8] === "Z" ? 0 : (m[9] === "-" ? -1 : 1) * (Number(m[10]) * 60 + Number(m[11]));
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || se > 59 || (m[8] !== "Z" && (Number(m[10]) > 23 || Number(m[11]) > 59))) return null;
  const local = Date.UTC(y, mo - 1, d, h, mi, se, ms);
  if (new Date(local).getUTCDate() !== d) return null; // 2026-02-30 and the like
  const utc = local - off * 60000;
  if (utc < 0 || utc >= Date.UTC(10000, 0, 1)) return null; // 1970 to 9999 only, so the text form stays fixed
  const t = new Date(utc).toISOString(); // YYYY-MM-DDTHH:MM:SS.mmmZ
  return ms === 0 ? `${t.slice(0, 19)}Z` : t;
}
const utcOr = (x, code) => {
  const t = toUtc(x);
  if (!t) throw new RunError(code);
  return t;
};

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const isInt = (v, lo, hi) => typeof v === "number" && Number.isSafeInteger(v) && v >= lo && v <= hi;
const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && toUtc(v) !== null;
/**
 * Issuer fields that reach public_metrics, in check order: [field, required for kind, min, max]. Optional fields may
 * be absent or null (read as 0); anything present must be an integer in range. Then the source rows that feed the
 * aggregates: roster, claims, bank transactions. Integers must be written without a fraction or exponent (the Rust
 * build reads JSON 100.0 as a float and refuses it).
 */
export const ISSUER_FIELDS = [
  ["occupancy_bps", "rental", 0, 10000],
  ["reported_yield_bps", "credit", 0, 10000],
  ["principal_outstanding_cents", "credit", 0, MAX_SAFE],
  ["accrued_interest_cents", null, 0, MAX_SAFE],
  ["capitalized_interest_cents", null, 0, MAX_SAFE],
  ["expenses_cents", null, 0, MAX_SAFE],
  ["reserves_cents", null, 0, MAX_SAFE],
  ["distributions_paid_cents", null, 0, MAX_SAFE],
];
function validateFields(ds, isCredit, mgr) {
  const kind = isCredit ? "credit" : "rental";
  for (const [f, requiredFor, lo, hi] of ISSUER_FIELDS) {
    const v = ds.issuer[f];
    if (v === undefined || v === null) {
      if (requiredFor === kind) throw new RunError(`${f}_invalid`);
      continue;
    }
    if (!isInt(v, lo, hi)) throw new RunError(`${f}_invalid`);
  }
  for (const r of isCredit ? mgr.loans : mgr.units) {
    const ok = r !== null && typeof r === "object" && (isCredit ? isInt(r.principal_cents, 0, MAX_SAFE) : isInt(r.rent_cents, 0, MAX_SAFE) && typeof r.occupied === "boolean");
    if (!ok) throw new RunError("roster_invalid");
  }
  const claims = isCredit ? mgr.payments : mgr.ledger;
  if (!Array.isArray(claims)) throw new RunError("claim_invalid");
  for (const c of claims) if (!(c !== null && typeof c === "object" && isInt(c.amount_cents, 0, MAX_SAFE) && isDate(c.paid_date))) throw new RunError("claim_invalid");
  if (!Array.isArray(ds.bank_feed.transactions)) throw new RunError("bank_txn_invalid");
  for (const t of ds.bank_feed.transactions) if (!(t !== null && typeof t === "object" && isInt(t.amount_cents, -MAX_SAFE, MAX_SAFE) && isDate(t.date))) throw new RunError("bank_txn_invalid");
}

const sha = (x) => createHash("sha256").update(typeof x === "string" ? x : JSON.stringify(x)).digest("hex");
const hoursBetween = (fromIso, toIso) => Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 3600000));

/**
 * ds: a dataset (cashflow/demo/data.mjs shape). key: pseudonym key. asOf: run time (ISO date or timestamp).
 * bankFetchedAt: when the TEE fetched the bank feed (defaults to asOf). previous: { [source]: { snapshot_sha256,
 * as_of } } from the previous run's passport, for the carried-forward rule; newPeriod: whether a new period started.
 */
export function runFund(ds, { key, asOf, period, daysInPeriod, bankFetchedAt = asOf, previous = {}, newPeriod = false }) {
  // ---- validate every source up front: fail closed with a named code, before any adapter runs ----------------
  const isCreditKind = ds && ds.kind === "credit";
  const mgrDoc = ds && (isCreditKind ? ds.servicer_tape : ds.manager_export);
  const mgrSrc = isCreditKind ? "servicer_records" : "property_manager_records";
  const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
  if (!ds || (ds.kind !== "credit" && ds.kind !== "rental")) throw new RunError("dataset_kind");
  if (!isObj(ds.bank_feed)) throw new RunError("source_missing_bank_settlements");
  if (!isObj(mgrDoc)) throw new RunError(`source_missing_${mgrSrc}`);
  if (!isObj(ds.issuer)) throw new RunError("source_missing_issuer_claims");
  const runAt = utcOr(asOf, "as_of_invalid_run");
  const asOfUtc = {
    bank_settlements: bankFetchedAt == null ? null : utcOr(bankFetchedAt, "as_of_invalid_bank_settlements"),
    [mgrSrc]: mgrDoc.as_of == null ? null : utcOr(mgrDoc.as_of, `as_of_invalid_${mgrSrc}`),
    issuer_claims: ds.issuer.as_of == null ? null : utcOr(ds.issuer.as_of, "as_of_invalid_issuer_claims"),
  };
  for (const [src, t] of Object.entries(asOfUtc)) if (t === null) throw new RunError(`as_of_missing_${src}`);
  // dues (spec 5.7): the schedule must be there and every row complete; written-off rows still count
  const dueRows = isCreditKind ? mgrDoc.schedule : mgrDoc.charges;
  if (!Array.isArray(dueRows) || !Array.isArray(isCreditKind ? mgrDoc.loans : mgrDoc.units)) throw new RunError("dues_missing");
  const idKey = isCreditKind ? "loan_id" : "unit_id";
  for (const r of dueRows) {
    const ok = isObj(r) && typeof r[idKey] === "string" && r[idKey] !== "" && typeof r.due_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.due_date) && toUtc(r.due_date) !== null && Number.isSafeInteger(r.amount_cents) && r.amount_cents >= 0;
    if (!ok) throw new RunError("dues_incomplete");
  }
  // every issuer- or source-supplied value that reaches public_metrics: fixed type and range, fail closed with a
  // fixed code and never echo the value (owner review 8 Nov)
  validateFields(ds, isCreditKind, mgrDoc);
  const prevUtc = {};
  for (const [src, p] of Object.entries(previous)) prevUtc[src] = { snapshot_sha256: p.snapshot_sha256, as_of: utcOr(p.as_of, `as_of_invalid_previous_${src}`) };

  const bank = settledFromFeed(ds.bank_feed, key);
  const isCredit = ds.kind === "credit";
  const src = isCredit ? fromServicerTape(ds.servicer_tape, key) : fromManagerExport(ds.manager_export, key);
  const m = match({ due: src.due, claims: src.claims, bank, payers: src.payers });
  const issuer = isCredit ? ds.issuer : { ...ds.issuer, occupancy_bps: ds.issuer.occupancy_bps };
  const mt = metrics({ kind: ds.kind, m, issuer, units: src.units || {}, asOf: runAt.slice(0, 10), period, daysInPeriod });
  const mgrSrcName = isCredit ? "servicer_records" : "property_manager_records";
  mt.collection = collection({ m, period, runAt, coverage: { bank_settlements: asOfUtc.bank_settlements, [mgrSrcName]: asOfUtc[mgrSrcName] }, activeUnits: src.active_units, fail: (code) => { throw new RunError(code); } });

  // Freshness per source from that source's own as-of (spec 5.6): the TEE's fetch time for the bank feed, the
  // export timestamp for the manager file, the issuer's own as_of for its claims. carried_forward, per source, once
  // a new period has started: the same snapshot hash as the previous run, or an as-of that did not advance.
  const managerExport = isCredit ? ds.servicer_tape : ds.manager_export;
  const mgrName = isCredit ? "servicer_records" : "property_manager_records";
  const raw = [
    { source: "bank_settlements", tier: 3, independence: "third_party_bank", cadence: "daily", as_of: asOfUtc.bank_settlements, bytes: ds.bank_feed, synthetic: !!ds.bank_feed.synthetic },
    { source: mgrName, tier: 2, independence: "issuer_appointed_manager", cadence: "monthly", as_of: asOfUtc[mgrName], bytes: managerExport, synthetic: !!ds.synthetic },
    { source: "issuer_claims", tier: 1, independence: "issuer", cadence: "monthly", as_of: asOfUtc.issuer_claims, bytes: ds.issuer, synthetic: !!ds.synthetic },
  ];
  const sources = raw.map(({ bytes, ...x }) => {
    const snapshot_sha256 = sha(bytes);
    const prev = prevUtc[x.source];
    const carried_forward = !!(newPeriod && prev && (prev.snapshot_sha256 === snapshot_sha256 || !(Date.parse(x.as_of) > Date.parse(prev.as_of))));
    return { ...x, age_hours: hoursBetween(x.as_of, runAt), carried_forward, snapshot_sha256 };
  });
  const s = score(scoreInput(mt, sources));
  const passport = sources.map((x) => ({ ...x, freshness_bps: sourceFreshnessBps(x), method_version: METHOD }));
  return { token_id: ds.id, kind: ds.kind, method: METHOD, match: m, metrics: mt, public_metrics: publicMetrics(mt), passport, score: s };
}
