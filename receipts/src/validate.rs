//! What a receipt may contain before it is stored on chain (spec/v2/SPEC.md sections 8.1 and 9).
//!
//! Everything stored here is public chain state, so the contract checks the receipt against a closed whitelist:
//! the exact top-level fields; aggregates as integers (or null) only; strings only where the field is a fixed code,
//! a period, a date or a cap or hold reason; caps and holds from the method's fixed list; passport entries with
//! whole-document sha256 hashes; any cohort under 5 units suppressed. Anything else (an id, a name, a pseudonym, a
//! free-text field, an unknown key) makes the receipt rejected, and nothing is stored. Pure functions, no chain I/O.
use near_sdk::serde_json::{Map, Value};

pub const RECEIPT_VERSION: &str = "2";
pub const MAX_RECEIPT_BYTES: usize = 10_000;

const TOP: [&str; 22] = [
    "as_of", "band", "caps", "checks_run", "evidence_hashes", "exceptions", "holds", "kind", "method", "metrics", "missing_evidence", "parts_x100", "passport", "period",
    "raw_x100", "receipt_sha256", "receipt_version", "run_nonce", "score", "synthetic", "token_id", "uncapped_score",
];
pub const CAP_CODES: [&str; 6] = ["self_reported_only", "yield_gap", "payout_exceeds_net_cash", "distribution_funded_by_sponsor", "claimed_not_settled", "collection_shortfall"];
pub const HOLD_CODES: [&str; 2] = ["collection_pending", "collection_not_applicable"];
const SOURCES: [&str; 4] = ["bank_settlements", "servicer_records", "property_manager_records", "issuer_claims"];
const CHECKS: [&str; 9] = [
    "three_way_match", "reversals_and_duplicates", "non_income_credits", "cash_yield_vs_reported", "rental_coverage", "late_payment_cohorts", "freshness_and_carry_forward",
    "collection_by_cutoff", "red_flag_caps",
];
const EXCEPTIONS: [&str; 9] = [
    "claimed_not_settled", "settled_not_claimed", "duplicate_claim", "duplicate_bank_txn", "probable_reversal", "batch_mismatch", "claim_without_due", "unapplied_credit",
    "distribution_funded_by_sponsor",
];
const METRIC_INTS: [&str; 19] = [
    "accrued_interest_cents", "capitalized_interest_cents", "cash_interest_cents", "cash_match_bps", "cash_received_cents", "cash_yield_bps", "claimed_cash_cents",
    "collection_rate_bps", "distributions_cents", "expenses_cents", "late_share_bps", "net_operating_cash_cents", "occupancy_bps", "rent_collected_cents", "rent_due_cents",
    "rental_coverage_bps", "reported_yield_bps", "reserves_cents", "yield_gap_bps",
];
const FLAGS: [&str; 2] = ["distributions_self_reported", "expenses_self_reported"];
const COHORTS: [&str; 4] = ["current", "30", "60", "90+"];
const PASSPORT_KEYS: [&str; 11] = ["source", "tier", "independence", "cadence", "as_of", "synthetic", "age_hours", "carried_forward", "snapshot_sha256", "freshness_bps", "method_version"];
const INDEPENDENCE: [&str; 3] = ["third_party_bank", "issuer_appointed_manager", "issuer"];
const PENDING_REASONS: [&str; 4] = ["before_cutoff", "no_coverage_bank_settlements", "no_coverage_servicer_records", "no_coverage_property_manager_records"];

/// The pending request a receipt must answer.
pub struct Expect<'a> {
    pub method: &'a str,
    pub token_id: &'a str,
    pub kind: &'a str,
    pub run_nonce: &'a str,
}

/// The fields the contract indexes, taken from a receipt that passed `check`.
#[derive(Debug, PartialEq)]
pub struct Summary {
    pub score: u64,
    pub band: String,
    pub period: String,
    pub as_of: String,
    pub caps: Vec<String>,
    pub holds: Vec<String>,
}

type V = Result<(), String>;
fn bad(what: &str) -> String {
    format!("receipt_rejected:{what}")
}
fn obj<'a>(v: &'a Value, what: &str) -> Result<&'a Map<String, Value>, String> {
    v.as_object().ok_or_else(|| bad(what))
}
fn arr<'a>(v: &'a Value, what: &str) -> Result<&'a Vec<Value>, String> {
    v.as_array().ok_or_else(|| bad(what))
}
fn str_of<'a>(v: &'a Value, what: &str) -> Result<&'a str, String> {
    v.as_str().ok_or_else(|| bad(what))
}
fn int_of(v: &Value, what: &str) -> Result<i64, String> {
    v.as_i64().ok_or_else(|| bad(what))
}
fn only_keys(m: &Map<String, Value>, allowed: &[&str], what: &str) -> V {
    match m.keys().find(|k| !allowed.contains(&k.as_str())) {
        Some(k) => Err(bad(&format!("{what}_unknown_field_{}", k.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').take(40).collect::<String>()))),
        None => Ok(()),
    }
}
fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn digits(s: &str) -> bool {
    s.bytes().all(|c| c.is_ascii_digit())
}
pub fn is_period(s: &str) -> bool {
    s.len() == 7 && digits(&s[0..4]) && &s[4..5] == "-" && digits(&s[5..7])
}
pub fn is_date(s: &str) -> bool {
    s.len() == 10 && is_period(&s[0..7]) && &s[7..8] == "-" && digits(&s[8..10])
}
/// "YYYY-MM-DDTHH:MM:SS[.mmm]Z" (the engine normalizes every timestamp to UTC).
pub fn is_utc_ts(s: &str) -> bool {
    let b = s.as_bytes();
    let base = s.len() >= 20 && is_date(&s[0..10]) && b[10] == b'T' && b[13] == b':' && b[16] == b':' && digits(&s[11..13]) && digits(&s[14..16]) && digits(&s[17..19]);
    base && (s.len() == 20 && b[19] == b'Z' || s.len() == 24 && b[19] == b'.' && digits(&s[20..23]) && b[23] == b'Z')
}
pub fn is_token_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'-')
}
fn band_for(score: u64) -> &'static str {
    if score >= 85 {
        "green"
    } else if score >= 60 {
        "yellow"
    } else {
        "red"
    }
}
fn coded(v: &Value, codes: &[&str], prefix: &str, what: &str) -> Result<String, String> {
    let m = obj(v, what)?;
    only_keys(m, &["code", "reason"], what)?;
    let code = str_of(m.get("code").unwrap_or(&Value::Null), what)?;
    if !codes.contains(&code) {
        return Err(bad(&format!("{what}_code")));
    }
    let reason = str_of(m.get("reason").unwrap_or(&Value::Null), what)?;
    if reason.len() > 200 || !reason.starts_with(prefix) || reason.bytes().any(|c| c < 0x20) {
        return Err(bad(&format!("{what}_reason")));
    }
    Ok(code.to_string())
}

fn check_metrics(m: &Value, kind: &str, period: &str) -> V {
    let m = obj(m, "metrics")?;
    for (k, v) in m {
        match k.as_str() {
            "kind" => {
                if v.as_str() != Some(kind) {
                    return Err(bad("metrics_kind"));
                }
            }
            "period" => {
                if v.as_str() != Some(period) {
                    return Err(bad("metrics_period"));
                }
            }
            "as_of" => {
                if !v.as_str().is_some_and(is_date) {
                    return Err(bad("metrics_as_of"));
                }
            }
            "flags" => {
                for f in arr(v, "metrics_flags")? {
                    if !f.as_str().is_some_and(|x| FLAGS.contains(&x)) {
                        return Err(bad("metrics_flags"));
                    }
                }
            }
            "cohorts" => {
                let c = obj(v, "metrics_cohorts")?;
                only_keys(c, &COHORTS, "metrics_cohorts")?;
                for x in c.values() {
                    let x = obj(x, "metrics_cohort")?;
                    if x.contains_key("suppressed") {
                        only_keys(x, &["suppressed"], "metrics_cohort")?;
                        if x["suppressed"].as_str() != Some("fewer than 5") {
                            return Err(bad("metrics_cohort"));
                        }
                    } else {
                        only_keys(x, &["units", "outstanding_cents"], "metrics_cohort")?;
                        let units = int_of(x.get("units").unwrap_or(&Value::Null), "metrics_cohort")?;
                        int_of(x.get("outstanding_cents").unwrap_or(&Value::Null), "metrics_cohort")?;
                        // privacy gate (spec 9): any group of 1 to 4 units is suppressed
                        if (1..5).contains(&units) {
                            return Err(bad("cohort_not_suppressed"));
                        }
                    }
                }
            }
            "exceptions" => {
                let e = obj(v, "metrics_exceptions")?;
                for (ek, ev) in e {
                    let known = EXCEPTIONS.contains(&ek.as_str()) || ek == "claimed_not_settled_cents";
                    if !known || ev.as_i64().is_none() {
                        return Err(bad("metrics_exceptions"));
                    }
                }
            }
            "collection" => {
                let c = obj(v, "metrics_collection")?;
                only_keys(c, &["period", "cutoff", "status", "dues_cents", "verified_cents", "rate_bps", "shortfall", "pending_reason"], "metrics_collection")?;
                if !c.get("period").and_then(Value::as_str).is_some_and(is_period) || !c.get("cutoff").and_then(Value::as_str).is_some_and(is_date) {
                    return Err(bad("metrics_collection"));
                }
                let status = c.get("status").and_then(Value::as_str).unwrap_or("");
                if !["verified", "pending", "not_applicable"].contains(&status) || !c.get("shortfall").is_some_and(Value::is_boolean) {
                    return Err(bad("metrics_collection"));
                }
                for k in ["dues_cents", "verified_cents", "rate_bps"] {
                    if !c.get(k).is_some_and(|x| x.is_null() || x.as_i64().is_some()) {
                        return Err(bad("metrics_collection"));
                    }
                }
                if let Some(r) = c.get("pending_reason") {
                    if !r.as_str().is_some_and(|x| PENDING_REASONS.contains(&x)) {
                        return Err(bad("metrics_collection"));
                    }
                }
            }
            k if METRIC_INTS.contains(&k) => {
                if !(v.is_null() || v.as_i64().is_some()) {
                    return Err(bad("metrics_value"));
                }
            }
            _ => return Err(bad(&format!("metrics_unknown_field_{}", k.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').take(40).collect::<String>()))),
        }
    }
    Ok(())
}

/// Check one receipt (the parsed OutLayer output) against the pending request. Ok gives the indexed summary.
pub fn check(v: &Value, e: &Expect) -> Result<Summary, String> {
    let m = obj(v, "not_an_object")?;
    only_keys(m, &TOP, "top")?;
    if let Some(k) = TOP.iter().find(|k| !m.contains_key(**k)) {
        return Err(bad(&format!("missing_{k}")));
    }
    if m["receipt_version"].as_str() != Some(RECEIPT_VERSION) {
        return Err(bad("receipt_version"));
    }
    if m["method"].as_str() != Some(e.method) {
        return Err(bad("method"));
    }
    if m["token_id"].as_str() != Some(e.token_id) {
        return Err(bad("token_id"));
    }
    if m["kind"].as_str() != Some(e.kind) {
        return Err(bad("kind"));
    }
    if m["run_nonce"].as_str() != Some(e.run_nonce) {
        return Err(bad("run_nonce"));
    }
    let period = str_of(&m["period"], "period")?;
    let as_of = str_of(&m["as_of"], "as_of")?;
    if !is_period(period) || !is_utc_ts(as_of) {
        return Err(bad("period_or_as_of"));
    }
    let score = m["score"].as_u64().filter(|s| *s <= 100).ok_or_else(|| bad("score"))?;
    m["uncapped_score"].as_u64().filter(|s| *s <= 100).ok_or_else(|| bad("uncapped_score"))?;
    m["raw_x100"].as_u64().filter(|s| *s <= 10_000).ok_or_else(|| bad("raw_x100"))?;
    let band = str_of(&m["band"], "band")?;
    if band != band_for(score) {
        return Err(bad("band"));
    }
    let parts = obj(&m["parts_x100"], "parts_x100")?;
    only_keys(parts, &["cash_match", "gap", "late", "freshness"], "parts_x100")?;
    for k in ["cash_match", "gap", "late", "freshness"] {
        parts.get(k).and_then(Value::as_u64).ok_or_else(|| bad("parts_x100"))?;
    }
    let mut caps = vec![];
    for c in arr(&m["caps"], "caps")? {
        caps.push(coded(c, &CAP_CODES, "red because", "cap")?);
    }
    let mut holds = vec![];
    for h in arr(&m["holds"], "holds")? {
        holds.push(coded(h, &HOLD_CODES, "not green because", "hold")?);
    }
    if caps.len() > CAP_CODES.len() || holds.len() > HOLD_CODES.len() {
        return Err(bad("too_many_codes"));
    }
    if !caps.is_empty() && score > 59 || !holds.is_empty() && score > 84 {
        return Err(bad("cap_not_applied"));
    }
    check_metrics(&m["metrics"], e.kind, period)?;
    let passport = arr(&m["passport"], "passport")?;
    if passport.is_empty() || passport.len() > SOURCES.len() {
        return Err(bad("passport"));
    }
    let mut sources = vec![];
    for p in passport {
        let p = obj(p, "passport")?;
        only_keys(p, &PASSPORT_KEYS, "passport")?;
        let src = p.get("source").and_then(Value::as_str).filter(|s| SOURCES.contains(s)).ok_or_else(|| bad("passport_source"))?;
        if sources.contains(&src) {
            return Err(bad("passport_duplicate_source"));
        }
        sources.push(src);
        if !p.get("snapshot_sha256").and_then(Value::as_str).is_some_and(is_hex64) {
            return Err(bad("passport_hash"));
        }
        let ok = p.get("tier").and_then(Value::as_u64).is_some_and(|t| (1..=3).contains(&t))
            && p.get("independence").and_then(Value::as_str).is_some_and(|x| INDEPENDENCE.contains(&x))
            && p.get("cadence").and_then(Value::as_str).is_some_and(|x| x == "daily" || x == "monthly")
            && p.get("as_of").and_then(Value::as_str).is_some_and(is_utc_ts)
            && p.get("synthetic").is_some_and(Value::is_boolean)
            && p.get("carried_forward").is_some_and(Value::is_boolean)
            && p.get("age_hours").and_then(Value::as_u64).is_some()
            && p.get("freshness_bps").and_then(Value::as_u64).is_some_and(|f| f <= 10_000)
            && p.get("method_version").and_then(Value::as_str) == Some(e.method);
        if !ok {
            return Err(bad("passport_entry"));
        }
    }
    let ev = arr(&m["evidence_hashes"], "evidence_hashes")?;
    if ev.len() != passport.len() {
        return Err(bad("evidence_hashes"));
    }
    for (x, p) in ev.iter().zip(passport) {
        let x = obj(x, "evidence_hashes")?;
        only_keys(x, &["source", "sha256"], "evidence_hashes")?;
        if x.get("source") != p.get("source") || x.get("sha256") != p.get("snapshot_sha256") {
            return Err(bad("evidence_hashes"));
        }
    }
    for c in arr(&m["checks_run"], "checks_run")? {
        if !c.as_str().is_some_and(|x| CHECKS.contains(&x)) {
            return Err(bad("checks_run"));
        }
    }
    for x in arr(&m["exceptions"], "exceptions")? {
        let x = obj(x, "exceptions")?;
        only_keys(x, &["code", "count"], "exceptions")?;
        let ok = x.get("code").and_then(Value::as_str).is_some_and(|c| EXCEPTIONS.contains(&c)) && x.get("count").and_then(Value::as_u64).is_some();
        if !ok {
            return Err(bad("exceptions"));
        }
    }
    for x in arr(&m["missing_evidence"], "missing_evidence")? {
        let ok = x.as_str().and_then(|s| s.strip_suffix("_stale_or_carried_forward")).is_some_and(|s| SOURCES.contains(&s));
        if !ok {
            return Err(bad("missing_evidence"));
        }
    }
    if !m["synthetic"].is_boolean() {
        return Err(bad("synthetic"));
    }
    if !m["receipt_sha256"].as_str().is_some_and(is_hex64) {
        return Err(bad("receipt_sha256"));
    }
    Ok(Summary { score, band: band.to_string(), period: period.to_string(), as_of: as_of.to_string(), caps, holds })
}

/// A failure stage printed by the module: a short code of lowercase letters, digits and underscores.
pub fn is_stage(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
}
