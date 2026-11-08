//! One run (cashflow/run.mjs): adapters, match, metrics, passport, score; plus the public receipt the TEE prints.
use crate::base::*;
use crate::matcher::*;
use crate::metrics::*;
use serde_json::{json, Value};

pub struct RunOptions<'a> {
    pub as_of: &'a str,
    pub period: &'a str,
    pub days_in_period: i64,
    pub bank_fetched_at: &'a str,
    /// previous run's passport: source -> (snapshot_sha256, as_of)
    pub previous: Vec<(String, String, String)>,
    pub new_period: bool,
}

pub struct RunResult {
    pub token_id: String,
    pub kind: String,
    pub matched: Value,
    pub metrics: Value,
    pub public_metrics: Value,
    pub passport: Vec<Value>,
    pub score: Value,
}

/// Named fail-closed codes from source validation (the TEE prints them as its stage). Same codes as the reference.
pub const VALIDATION_CODES: [&str; 27] = [
    "dues_missing",
    "dues_incomplete",
    "occupancy_bps_invalid",
    "reported_yield_bps_invalid",
    "principal_outstanding_cents_invalid",
    "accrued_interest_cents_invalid",
    "capitalized_interest_cents_invalid",
    "expenses_cents_invalid",
    "reserves_cents_invalid",
    "distributions_paid_cents_invalid",
    "roster_invalid",
    "claim_invalid",
    "bank_txn_invalid",
    "dataset_kind",
    "source_missing_bank_settlements",
    "source_missing_servicer_records",
    "source_missing_property_manager_records",
    "source_missing_issuer_claims",
    "as_of_invalid_run",
    "as_of_missing_bank_settlements",
    "as_of_missing_servicer_records",
    "as_of_missing_property_manager_records",
    "as_of_missing_issuer_claims",
    "as_of_invalid_bank_settlements",
    "as_of_invalid_servicer_records",
    "as_of_invalid_property_manager_records",
    "as_of_invalid_issuer_claims",
];
/// The validation code an error string carries, if it is one (else the error is a generic run failure). A bad
/// previous as_of is reported without the source name, which comes from the public input.
pub fn validation_code(e: &str) -> Option<&'static str> {
    VALIDATION_CODES.iter().copied().find(|c| *c == e).or_else(|| e.starts_with("as_of_invalid_previous_").then_some("as_of_invalid_previous"))
}
fn utc_or(x: &str, code: &str) -> R<String> {
    to_utc(x).ok_or_else(|| code.to_string())
}
/// A document's own as_of: Ok(None) when missing or null, as_of_invalid when present but not a valid timestamp
/// string. The reference checks every invalid value first, then every missing one (same codes in the same order).
fn doc_as_of(doc: &Value, src: &str) -> R<Option<String>> {
    match doc.get("as_of") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(t)) => utc_or(t, &format!("as_of_invalid_{src}")).map(Some),
        Some(_) => Err(format!("as_of_invalid_{src}")),
    }
}
const MAX_SAFE: i64 = 9_007_199_254_740_991;
/// Issuer fields that reach public_metrics, in the reference's check order (cashflow/run.mjs ISSUER_FIELDS):
/// (field, required for kind, min, max). Optional fields may be absent or null.
const ISSUER_FIELDS: [(&str, Option<&str>, i64, i64); 8] = [
    ("occupancy_bps", Some("rental"), 0, 10_000),
    ("reported_yield_bps", Some("credit"), 0, 10_000),
    ("principal_outstanding_cents", Some("credit"), 0, MAX_SAFE),
    ("accrued_interest_cents", None, 0, MAX_SAFE),
    ("capitalized_interest_cents", None, 0, MAX_SAFE),
    ("expenses_cents", None, 0, MAX_SAFE),
    ("reserves_cents", None, 0, MAX_SAFE),
    ("distributions_paid_cents", None, 0, MAX_SAFE),
];
/// A JSON integer (no fraction or exponent) in [lo, hi].
fn int_in(v: Option<&Value>, lo: i64, hi: i64) -> bool {
    v.and_then(Value::as_i64).is_some_and(|x| (lo..=hi).contains(&x))
}
fn date_ok(v: Option<&Value>) -> bool {
    v.and_then(Value::as_str).is_some_and(|x| x.len() == 10 && x.as_bytes()[4] == b'-' && x.as_bytes()[7] == b'-' && x.bytes().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit()) && to_utc(x).is_some())
}
/// Every issuer- or source-supplied value that reaches public_metrics: fixed type and range, fixed code, the value
/// never echoed (owner review 8 Nov). Same order and codes as the reference.
fn validate_fields(issuer: &Value, mgr: &Value, bank_feed: &Value, is_credit: bool) -> R<()> {
    let kind = if is_credit { "credit" } else { "rental" };
    for (f, required_for, lo, hi) in ISSUER_FIELDS {
        match issuer.get(f) {
            None | Some(Value::Null) => {
                if required_for == Some(kind) {
                    return Err(format!("{f}_invalid"));
                }
            }
            v => {
                if !int_in(v, lo, hi) {
                    return Err(format!("{f}_invalid"));
                }
            }
        }
    }
    let roster = mgr.get(if is_credit { "loans" } else { "units" }).and_then(Value::as_array).ok_or("roster_invalid")?;
    for r in roster {
        let ok = r.is_object() && if is_credit { int_in(r.get("principal_cents"), 0, MAX_SAFE) } else { int_in(r.get("rent_cents"), 0, MAX_SAFE) && r.get("occupied").is_some_and(Value::is_boolean) };
        if !ok {
            return Err("roster_invalid".into());
        }
    }
    let claims = mgr.get(if is_credit { "payments" } else { "ledger" }).and_then(Value::as_array).ok_or("claim_invalid")?;
    if !claims.iter().all(|c| c.is_object() && int_in(c.get("amount_cents"), 0, MAX_SAFE) && date_ok(c.get("paid_date"))) {
        return Err("claim_invalid".into());
    }
    let txns = bank_feed.get("transactions").and_then(Value::as_array).ok_or("bank_txn_invalid")?;
    if !txns.iter().all(|t| t.is_object() && int_in(t.get("amount_cents"), -MAX_SAFE, MAX_SAFE) && date_ok(t.get("date"))) {
        return Err("bank_txn_invalid".into());
    }
    Ok(())
}

/// The reference's due-row check (cashflow/run.mjs): id, ISO date, non-negative safe integer amount.
fn due_row_ok(r: &Value, id_key: &str) -> bool {
    let id_ok = r.get(id_key).and_then(Value::as_str).is_some_and(|x| !x.is_empty());
    let date_ok = r.get("due_date").and_then(Value::as_str).is_some_and(|x| x.len() == 10 && x.as_bytes()[4] == b'-' && x.as_bytes()[7] == b'-' && x.bytes().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit()) && to_utc(x).is_some());
    let amt_ok = r.get("amount_cents").and_then(Value::as_i64).is_some_and(|a| (0..=9_007_199_254_740_991).contains(&a));
    r.is_object() && id_ok && date_ok && amt_ok
}

/// `ds` has the dataset shape of cashflow/demo/data.mjs: id, kind, synthetic, bank_feed, servicer_tape or
/// manager_export, issuer. Sources are hashed as JSON.stringify of the document, keys in their delivered order.
pub fn run_fund(ds: &Value, p: &dyn Pseudonymizer, o: &RunOptions) -> R<RunResult> {
    // ---- validate every source up front (cashflow/run.mjs): fail closed with a named code ----------------------
    let kind = match ds.get("kind").and_then(Value::as_str) {
        Some(k @ ("credit" | "rental")) => k.to_string(),
        _ => return Err("dataset_kind".into()),
    };
    let is_credit = kind == "credit";
    let mgr_key = if is_credit { "servicer_tape" } else { "manager_export" };
    let mgr_name = if is_credit { "servicer_records" } else { "property_manager_records" };
    let obj = |k: &str, src: &str| -> R<&Value> { ds.get(k).filter(|v| v.is_object()).ok_or_else(|| format!("source_missing_{src}")) };
    let bank_feed = obj("bank_feed", "bank_settlements")?;
    let mgr = obj(mgr_key, mgr_name)?;
    let issuer = obj("issuer", "issuer_claims")?;
    let run_at = utc_or(o.as_of, "as_of_invalid_run")?;
    let bank_as_of = utc_or(o.bank_fetched_at, "as_of_invalid_bank_settlements")?;
    let mgr_as_of = doc_as_of(mgr, mgr_name)?;
    let issuer_as_of = doc_as_of(issuer, "issuer_claims")?;
    let mgr_as_of = mgr_as_of.ok_or_else(|| format!("as_of_missing_{mgr_name}"))?;
    let issuer_as_of = issuer_as_of.ok_or("as_of_missing_issuer_claims")?;
    let (rows_key, roster_key, id_key) = if is_credit { ("schedule", "loans", "loan_id") } else { ("charges", "units", "unit_id") };
    let (Some(rows), true) = (mgr.get(rows_key).and_then(Value::as_array), mgr.get(roster_key).is_some_and(Value::is_array)) else {
        return Err("dues_missing".into());
    };
    if !rows.iter().all(|r| due_row_ok(r, id_key)) {
        return Err("dues_incomplete".into());
    }
    validate_fields(issuer, mgr, bank_feed, is_credit)?;
    let mut previous = vec![];
    for (src, sha, pa) in &o.previous {
        previous.push((src.clone(), sha.clone(), utc_or(pa, &format!("as_of_invalid_previous_{src}"))?));
    }

    let bank = settled_from_feed(bank_feed, p)?;
    let src = if is_credit { from_servicer_tape(mgr, p)? } else { from_manager_export(mgr, p)? };
    let units = src.units.clone();
    let active_units = src.active_units.clone();
    let m = three_way(src, bank)?;
    let as_of_date: String = run_at.chars().take(10).collect();
    let mut mt = metrics(&kind, &m, issuer, &units, &as_of_date, o.period, o.days_in_period)?;
    let matched = matched_json(&m);
    mt["collection"] = collection(&matched, o.period, &run_at, &[("bank_settlements", bank_as_of.as_str()), (mgr_name, mgr_as_of.as_str())], &active_units)?;

    let ds_synth = truthy(ds, "synthetic");
    let raw: Vec<(&str, i64, &str, &str, String, &Value, bool)> = vec![
        ("bank_settlements", 3, "third_party_bank", "daily", bank_as_of, bank_feed, truthy(bank_feed, "synthetic")),
        (mgr_name, 2, "issuer_appointed_manager", "monthly", mgr_as_of, mgr, ds_synth),
        ("issuer_claims", 1, "issuer", "monthly", issuer_as_of, issuer, ds_synth),
    ];
    let mut passport = vec![];
    let mut score_sources = vec![];
    for (source, tier, indep, cadence, as_of, bytes, synthetic) in raw {
        let snapshot = sha256_hex(js_stringify(bytes)?.as_bytes());
        let prev = previous.iter().find(|(k, _, _)| k == source);
        let carried = o.new_period && prev.map(|(_, sha, pa)| *sha == snapshot || parse_ts(&as_of).ok() <= parse_ts(pa).ok()).unwrap_or(false);
        let age = hours_between(&as_of, &run_at)?;
        let ss = ScoreSource { tier, cadence: cadence.into(), age_hours: age, carried_forward: carried };
        passport.push(json!({ "source": source, "tier": tier, "independence": indep, "cadence": cadence, "as_of": as_of, "synthetic": synthetic, "age_hours": age, "carried_forward": carried, "snapshot_sha256": snapshot, "freshness_bps": source_freshness_bps(&ss)?, "method_version": METHOD }));
        score_sources.push(ss);
    }
    let sc = score(&mt, &score_sources)?;
    Ok(RunResult { token_id: s(ds, "id")?, kind, matched, public_metrics: public_metrics(&mt), metrics: mt, passport, score: sc })
}

/// The parity fixture output (cashflow/fixtures/make-parity.mjs parityOutput), canonical JSON.
pub fn parity_output(r: &RunResult) -> R<String> {
    canonical(&json!({ "token_id": r.token_id, "kind": r.kind, "method": METHOD, "match": r.matched, "metrics": r.metrics, "public_metrics": r.public_metrics, "passport": r.passport, "score": r.score }))
}

/// The public checks receipt (spec section 8.1). Aggregates only: no pseudonymous ref, no per-unit row, no value
/// derived from a secret. Evidence hashes are hashes of the source documents the TEE read.
pub fn receipt(r: &RunResult, run_nonce: &str, as_of: &str) -> R<Value> {
    let sc = &r.score;
    let evidence: Vec<Value> = r.passport.iter().map(|p| json!({ "source": p["source"], "sha256": p["snapshot_sha256"] })).collect();
    let synthetic = r.passport.iter().any(|p| p["synthetic"] == json!(true));
    let checks = ["three_way_match", "reversals_and_duplicates", "non_income_credits", "cash_yield_vs_reported", "rental_coverage", "late_payment_cohorts", "freshness_and_carry_forward", "collection_by_cutoff", "red_flag_caps"];
    let ex = r.metrics.get("exceptions").and_then(Value::as_object).ok_or("exceptions missing")?;
    let exceptions: Vec<Value> = ex.iter().filter(|(k, v)| !k.ends_with("_cents") && v.as_i64().unwrap_or(0) > 0).map(|(k, v)| json!({ "code": k, "count": v })).collect();
    let missing: Vec<Value> = r.passport.iter().filter(|p| p["carried_forward"] == json!(true) || p["freshness_bps"] == json!(0)).map(|p| json!(format!("{}_stale_or_carried_forward", p["source"].as_str().unwrap_or("")))).collect();
    let mut rec = json!({
        "receipt_version": "2",
        "method": METHOD,
        "token_id": r.token_id,
        "kind": r.kind,
        "run_nonce": run_nonce,
        "period": r.metrics["period"],
        "as_of": as_of,
        "score": sc["score"],
        "band": sc["band"],
        "uncapped_score": sc["uncapped_score"],
        "raw_x100": sc["raw_x100"],
        "parts_x100": sc["parts_x100"],
        "caps": sc["caps"],
        "holds": sc["holds"],
        "metrics": r.public_metrics,
        "passport": r.passport,
        "evidence_hashes": evidence,
        "checks_run": checks,
        "exceptions": exceptions,
        "missing_evidence": missing,
        "synthetic": synthetic,
    });
    let hash = sha256_hex(canonical(&rec)?.as_bytes());
    rec["receipt_sha256"] = json!(hash);
    Ok(rec)
}
