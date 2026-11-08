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

fn as_of_of(x: &str) -> String {
    if x.chars().count() == 10 {
        format!("{x}T00:00:00Z")
    } else {
        x.to_string()
    }
}

/// `ds` has the dataset shape of cashflow/demo/data.mjs: id, kind, synthetic, bank_feed, servicer_tape or
/// manager_export, issuer. Sources are hashed as JSON.stringify of the document, keys in their delivered order.
pub fn run_fund(ds: &Value, p: &dyn Pseudonymizer, o: &RunOptions) -> R<RunResult> {
    let kind = s(ds, "kind")?;
    let is_credit = kind == "credit";
    let bank_feed = ds.get("bank_feed").ok_or("bank_feed missing")?;
    let bank = settled_from_feed(bank_feed, p)?;
    let mgr_key = if is_credit { "servicer_tape" } else { "manager_export" };
    let mgr = ds.get(mgr_key).ok_or_else(|| format!("{mgr_key} missing"))?;
    let src = if is_credit { from_servicer_tape(mgr, p)? } else { from_manager_export(mgr, p)? };
    let units = src.units.clone();
    let m = three_way(src, bank)?;
    let issuer = ds.get("issuer").ok_or("issuer missing")?;
    let as_of_date: String = o.as_of.chars().take(10).collect();
    let mt = metrics(&kind, &m, issuer, &units, &as_of_date, o.period, o.days_in_period)?;

    let mgr_name = if is_credit { "servicer_records" } else { "property_manager_records" };
    let ds_synth = truthy(ds, "synthetic");
    let raw: Vec<(&str, i64, &str, &str, String, &Value, bool)> = vec![
        ("bank_settlements", 3, "third_party_bank", "daily", as_of_of(o.bank_fetched_at), bank_feed, truthy(bank_feed, "synthetic")),
        (mgr_name, 2, "issuer_appointed_manager", "monthly", as_of_of(&s(mgr, "as_of")?), mgr, ds_synth),
        ("issuer_claims", 1, "issuer", "monthly", as_of_of(&s(issuer, "as_of")?), issuer, ds_synth),
    ];
    let mut passport = vec![];
    let mut score_sources = vec![];
    for (source, tier, indep, cadence, as_of, bytes, synthetic) in raw {
        let snapshot = sha256_hex(js_stringify(bytes)?.as_bytes());
        let prev = o.previous.iter().find(|(k, _, _)| k == source);
        let carried = o.new_period && prev.map(|(_, sha, pa)| *sha == snapshot || parse_ts(&as_of).ok() <= parse_ts(pa).ok()).unwrap_or(false);
        let age = hours_between(&as_of, o.as_of)?;
        let ss = ScoreSource { tier, cadence: cadence.into(), age_hours: age, carried_forward: carried };
        passport.push(json!({ "source": source, "tier": tier, "independence": indep, "cadence": cadence, "as_of": as_of, "synthetic": synthetic, "age_hours": age, "carried_forward": carried, "snapshot_sha256": snapshot, "freshness_bps": source_freshness_bps(&ss)?, "method_version": METHOD }));
        score_sources.push(ss);
    }
    let sc = score(&mt, &score_sources)?;
    Ok(RunResult { token_id: s(ds, "id")?, kind, matched: matched_json(&m), public_metrics: public_metrics(&mt), metrics: mt, passport, score: sc })
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
    let checks = ["three_way_match", "reversals_and_duplicates", "non_income_credits", "cash_yield_vs_reported", "rental_coverage", "late_payment_cohorts", "freshness_and_carry_forward", "red_flag_caps"];
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
