//! What a receipt may contain before it is stored on chain (spec/v2/SPEC.md sections 8.1 and 9).
//!
//! Everything stored here is public chain state, so the contract checks the receipt against a closed schema:
//! - the exact field set at every level (required fields, no others), per fund type for the metrics;
//! - aggregates as integers in range; strings only where the field is a fixed code, a period, a date or a UTC
//!   timestamp, each checked as ASCII before it is parsed;
//! - cap and hold reasons equal to the method's exact template for their code (the collection_shortfall reason is
//!   rebuilt from the receipt's own collection block);
//! - the score, band, caps, holds, collection outcome, exceptions and missing-evidence list consistent with each
//!   other the way the engine derives them;
//! - passport entries in source order with whole-document sha256 hashes; any cohort of 1 to 4 units suppressed.
//!
//! A rejection is one fixed code, never a piece of the input. Pure functions, no chain I/O, no panics on any input.
use near_sdk::serde_json::{Map, Value};

pub const RECEIPT_VERSION: &str = "2";
pub const MAX_RECEIPT_BYTES: usize = 10_000;

const TOP: [&str; 22] = [
    "as_of", "band", "caps", "checks_run", "evidence_hashes", "exceptions", "holds", "kind", "method", "metrics", "missing_evidence", "parts_x100", "passport", "period",
    "raw_x100", "receipt_sha256", "receipt_version", "run_nonce", "score", "synthetic", "token_id", "uncapped_score",
];
/// The red-flag caps and their exact reasons (spec/v2/score.mjs CAPS). collection_shortfall is a template.
pub const CAPS: [(&str, &str); 6] = [
    ("self_reported_only", "red because no fresh bank-sourced evidence was available: self-reported only"),
    ("yield_gap", "red because the reported yield is at least 3.00 percentage points above the cash yield"),
    ("payout_exceeds_net_cash", "red because payouts exceed net cash from rent"),
    ("distribution_funded_by_sponsor", "red because part of a payout was funded by a sponsor transfer, not by income"),
    ("claimed_not_settled", "red because more than 2% of the cash the manager reports was never settled by the bank"),
    ("collection_shortfall", ""),
];
pub const HOLDS: [(&str, &str); 2] = [
    ("collection_pending", "not green because collection for the period cannot be verified yet: before the cutoff or without source coverage through it"),
    ("collection_not_applicable", "not green because no contractual dues fell in the period: inactivity alone is not green"),
];
pub const CHECKS: [&str; 9] = [
    "three_way_match", "reversals_and_duplicates", "non_income_credits", "cash_yield_vs_reported", "rental_coverage", "late_payment_cohorts", "freshness_and_carry_forward",
    "collection_by_cutoff", "red_flag_caps",
];
const EXCEPTIONS: [&str; 9] = [
    "claimed_not_settled", "settled_not_claimed", "duplicate_claim", "duplicate_bank_txn", "probable_reversal", "batch_mismatch", "claim_without_due", "unapplied_credit",
    "distribution_funded_by_sponsor",
];
const FLAGS: [&str; 2] = ["distributions_self_reported", "expenses_self_reported"];
const COHORTS: [&str; 4] = ["current", "30", "60", "90+"];
const PENDING_REASONS: [&str; 4] = ["before_cutoff", "no_coverage_bank_settlements", "no_coverage_servicer_records", "no_coverage_property_manager_records"];
const PASSPORT_KEYS: [&str; 11] = ["age_hours", "as_of", "cadence", "carried_forward", "freshness_bps", "independence", "method_version", "snapshot_sha256", "source", "synthetic", "tier"];
const MAX_SAFE: i64 = 9_007_199_254_740_991;

/// Metric fields shared by both fund types: (name, min, max) for the integers; kind, period, as_of, cohorts,
/// exceptions, flags and collection are checked on their own.
const METRIC_STRUCT: [&str; 7] = ["as_of", "cohorts", "collection", "exceptions", "flags", "kind", "period"];
/// Ratio bounds follow outlayer/engine-v2/src/metrics.rs: cash_match_bps is clamped to 10000; collection_rate_bps
/// caps each due's settled amount at the due; credit late_share_bps is principal 60+ days late over total principal
/// (a subset, so at most 10000); yield_gap_bps is at most reported_yield_bps; occupancy and reported yield are
/// validated in the engine. Rental late_share_bps is all arrears 60+ days late over ONE period's rent due, so months
/// of arrears legitimately exceed 10000 (4 months unpaid: 40000); it is allowed up to 100 periods of rent.
pub const RENTAL_LATE_SHARE_MAX_BPS: i64 = 1_000_000;
const METRIC_INTS_BOTH: [(&str, i64, i64); 3] = [("cash_received_cents", 0, MAX_SAFE), ("claimed_cash_cents", 0, MAX_SAFE), ("cash_match_bps", 0, 10_000)];
const METRIC_INTS_CREDIT: [(&str, i64, i64); 7] = [
    ("late_share_bps", 0, 10_000),
    ("cash_interest_cents", 0, MAX_SAFE),
    ("accrued_interest_cents", 0, MAX_SAFE),
    ("capitalized_interest_cents", 0, MAX_SAFE),
    ("reported_yield_bps", 0, 10_000),
    ("cash_yield_bps", 0, MAX_SAFE),
    ("yield_gap_bps", 0, 10_000),
];
const METRIC_INTS_RENTAL: [(&str, i64, i64); 10] = [
    ("late_share_bps", 0, RENTAL_LATE_SHARE_MAX_BPS),
    ("rent_due_cents", 0, MAX_SAFE),
    ("rent_collected_cents", 0, MAX_SAFE),
    ("collection_rate_bps", 0, 10_000),
    ("occupancy_bps", 0, 10_000),
    ("expenses_cents", 0, MAX_SAFE),
    ("reserves_cents", 0, MAX_SAFE),
    ("net_operating_cash_cents", -MAX_SAFE, MAX_SAFE),
    ("distributions_cents", 0, MAX_SAFE),
    ("rental_coverage_bps", 0, MAX_SAFE),
];

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

type R<T> = Result<T, String>;
/// The only way a rejection is written: a fixed code, never input text.
fn bad(code: &'static str) -> String {
    format!("receipt_rejected:{code}")
}
fn obj<'a>(v: &'a Value, code: &'static str) -> R<&'a Map<String, Value>> {
    v.as_object().ok_or_else(|| bad(code))
}
fn arr<'a>(v: &'a Value, code: &'static str) -> R<&'a Vec<Value>> {
    v.as_array().ok_or_else(|| bad(code))
}
fn ascii_str<'a>(v: Option<&'a Value>, code: &'static str) -> R<&'a str> {
    v.and_then(Value::as_str).filter(|s| s.is_ascii()).ok_or_else(|| bad(code))
}
fn int_in(v: Option<&Value>, lo: i64, hi: i64, code: &'static str) -> R<i64> {
    v.and_then(Value::as_i64).filter(|x| (lo..=hi).contains(x)).ok_or_else(|| bad(code))
}
/// The object has exactly these keys: none missing, none extra.
fn exact_keys(m: &Map<String, Value>, keys: &[&str], code: &'static str) -> R<()> {
    if m.len() == keys.len() && keys.iter().all(|k| m.contains_key(*k)) {
        Ok(())
    } else {
        Err(bad(code))
    }
}
fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn digits(b: &[u8]) -> bool {
    !b.is_empty() && b.iter().all(u8::is_ascii_digit)
}
/// "YYYY-MM": checked on bytes, so a string with a multi-byte character is refused, never sliced.
pub fn is_period(s: &str) -> bool {
    let b = s.as_bytes();
    s.is_ascii() && b.len() == 7 && digits(&b[0..4]) && b[4] == b'-' && digits(&b[5..7]) && (1..=12).contains(&((b[5] - b'0') * 10 + (b[6] - b'0')))
}
/// "YYYY-MM-DD".
pub fn is_date(s: &str) -> bool {
    let b = s.as_bytes();
    if !s.is_ascii() || b.len() != 10 || !is_period(&s[0..7]) || b[7] != b'-' || !digits(&b[8..10]) {
        return false;
    }
    let year = b[0..4].iter().fold(0u32, |n, digit| n * 10 + u32::from(digit - b'0'));
    let month = (b[5] - b'0') * 10 + (b[6] - b'0');
    let day = (b[8] - b'0') * 10 + (b[9] - b'0');
    let leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    let days = match month { 2 => if leap { 29 } else { 28 }, 4 | 6 | 9 | 11 => 30, _ => 31 };
    year != 0 && (1..=days).contains(&day)
}
/// "YYYY-MM-DDTHH:MM:SS[.mmm]Z" (the engine normalizes every timestamp to UTC).
pub fn is_utc_ts(s: &str) -> bool {
    let b = s.as_bytes();
    if !s.is_ascii() || !(b.len() == 20 || b.len() == 24) || !is_date(&s[0..10]) {
        return false;
    }
    let time = b[10] == b'T' && digits(&b[11..13]) && b[13] == b':' && digits(&b[14..16]) && b[16] == b':' && digits(&b[17..19]);
    let tail = if b.len() == 20 { b[19] == b'Z' } else { b[19] == b'.' && digits(&b[20..23]) && b[23] == b'Z' };
    if !time || !tail { return false; }
    // Mirror timestamps are nonnegative Unix milliseconds. No pre-epoch date or impossible clock is admitted.
    &s[0..4] >= "1970" && (b[11] - b'0') * 10 + (b[12] - b'0') <= 23
        && (b[14] - b'0') * 10 + (b[15] - b'0') <= 59 && (b[17] - b'0') * 10 + (b[18] - b'0') <= 59
}
pub fn is_token_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64
        && s.split('-').all(|part| !part.is_empty() && part.bytes().all(|c| c.is_ascii_alphanumeric()))
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
/// round(a / b) half up for a >= 0, b > 0 (spec section 10).
fn rhu(a: i64, b: i64) -> i64 {
    let q = a / b;
    if 2 * (a - q * b) >= b {
        q + 1
    } else {
        q
    }
}
fn pct(bps: i64) -> String {
    format!("{}.{:02}%", bps / 100, bps % 100)
}

/// The collection block (spec 5.7): exact keys for its status, values consistent with each other.
/// Returns (status, shortfall, rate_bps, period, cutoff).
fn check_collection(v: &Value) -> R<(&str, bool, i64, String, String)> {
    let c = obj(v, "metrics_collection")?;
    let status = ascii_str(c.get("status"), "metrics_collection")?;
    let base = ["cutoff", "dues_cents", "period", "rate_bps", "shortfall", "status", "verified_cents"];
    let period = ascii_str(c.get("period"), "metrics_collection")?;
    let cutoff = ascii_str(c.get("cutoff"), "metrics_collection")?;
    if !is_period(period) || !is_date(cutoff) {
        return Err(bad("metrics_collection"));
    }
    let shortfall = c.get("shortfall").and_then(Value::as_bool).ok_or_else(|| bad("metrics_collection"))?;
    let nulls = |ks: &[&str]| ks.iter().all(|k| c.get(*k) == Some(&Value::Null));
    match status {
        "verified" => {
            exact_keys(c, &base, "metrics_collection")?;
            let d = int_in(c.get("dues_cents"), 1, MAX_SAFE, "metrics_collection")?;
            let v = int_in(c.get("verified_cents"), 0, d, "metrics_collection")?;
            let rate = int_in(c.get("rate_bps"), 0, 10_000, "metrics_collection")?;
            // 10V < 9D on integers (exactly 90% passes); the rate is the rounded ratio
            if (d > MAX_SAFE / 10) || rate != rhu(10_000 * v, d) || shortfall != (10 * v < 9 * d) {
                return Err(bad("metrics_collection"));
            }
            Ok((status, shortfall, rate, period.into(), cutoff.into()))
        }
        "not_applicable" => {
            exact_keys(c, &base, "metrics_collection")?;
            let ok = c.get("dues_cents").and_then(Value::as_i64) == Some(0) && c.get("verified_cents").and_then(Value::as_i64) == Some(0) && nulls(&["rate_bps"]) && !shortfall;
            if !ok {
                return Err(bad("metrics_collection"));
            }
            Ok((status, false, 0, period.into(), cutoff.into()))
        }
        "pending" => {
            exact_keys(c, &["cutoff", "dues_cents", "pending_reason", "period", "rate_bps", "shortfall", "status", "verified_cents"], "metrics_collection")?;
            let reason = ascii_str(c.get("pending_reason"), "metrics_collection")?;
            if !PENDING_REASONS.contains(&reason) || !nulls(&["dues_cents", "verified_cents", "rate_bps"]) || shortfall {
                return Err(bad("metrics_collection"));
            }
            Ok((status, false, 0, period.into(), cutoff.into()))
        }
        _ => Err(bad("metrics_collection")),
    }
}

/// The public metrics block: the exact field set for the fund type. Returns the collection outcome and the
/// exception counts.
#[allow(clippy::type_complexity)]
fn check_metrics<'a>(v: &'a Value, kind: &str, period: &str) -> R<((&'a str, bool, i64, String, String), &'a Map<String, Value>)> {
    let m = obj(v, "metrics")?;
    let ints: Vec<(&str, i64, i64)> = METRIC_INTS_BOTH.iter().chain(if kind == "credit" { METRIC_INTS_CREDIT.iter() } else { [].iter() }).chain(if kind == "rental" { METRIC_INTS_RENTAL.iter() } else { [].iter() }).copied().collect();
    let mut names: Vec<&str> = METRIC_STRUCT.to_vec();
    names.extend(ints.iter().map(|x| x.0));
    exact_keys(m, &names, "metrics_fields")?;
    for (k, lo, hi) in &ints {
        int_in(m.get(*k), *lo, *hi, "metrics_value")?;
    }
    if ascii_str(m.get("kind"), "metrics_kind")? != kind {
        return Err(bad("metrics_kind"));
    }
    if ascii_str(m.get("period"), "metrics_period")? != period {
        return Err(bad("metrics_period"));
    }
    if !is_date(ascii_str(m.get("as_of"), "metrics_as_of")?) {
        return Err(bad("metrics_as_of"));
    }
    let flags = arr(&m["flags"], "metrics_flags")?;
    for (i, f) in flags.iter().enumerate() {
        let f = ascii_str(Some(f), "metrics_flags")?;
        if !FLAGS.contains(&f) || flags[..i].iter().any(|g| g.as_str() == Some(f)) {
            return Err(bad("metrics_flags"));
        }
    }
    let cohorts = obj(&m["cohorts"], "metrics_cohorts")?;
    exact_keys(cohorts, &COHORTS, "metrics_cohorts")?;
    for x in cohorts.values() {
        let x = obj(x, "metrics_cohorts")?;
        if x.contains_key("suppressed") {
            exact_keys(x, &["suppressed"], "metrics_cohorts")?;
            if x["suppressed"].as_str() != Some("fewer than 5") {
                return Err(bad("metrics_cohorts"));
            }
        } else {
            exact_keys(x, &["outstanding_cents", "units"], "metrics_cohorts")?;
            let units = int_in(x.get("units"), 0, MAX_SAFE, "metrics_cohorts")?;
            int_in(x.get("outstanding_cents"), 0, MAX_SAFE, "metrics_cohorts")?;
            // privacy gate (spec 9): any group of 1 to 4 units is suppressed
            if (1..5).contains(&units) {
                return Err(bad("cohort_not_suppressed"));
            }
        }
    }
    let ex = obj(&m["exceptions"], "metrics_exceptions")?;
    let mut ex_keys: Vec<&str> = EXCEPTIONS.to_vec();
    ex_keys.push("claimed_not_settled_cents");
    exact_keys(ex, &ex_keys, "metrics_exceptions")?;
    for k in &ex_keys {
        int_in(ex.get(*k), 0, MAX_SAFE, "metrics_exceptions")?;
    }
    Ok((check_collection(&m["collection"])?, ex))
}

/// The reason a cap code must carry, exactly.
fn cap_reason(code: &str, rate: i64, period: &str, cutoff: &str) -> Option<String> {
    if code == "collection_shortfall" {
        return Some(format!("red because of unverified collection: {} of contractual dues for {} were bank-confirmed by {} (at least 90.00% needed)", pct(rate), period, cutoff));
    }
    CAPS.iter().find(|c| c.0 == code).map(|c| c.1.to_string())
}
fn coded<'a>(v: &'a Value, code_list: &[&str], reason_of: impl Fn(&str) -> Option<String>, code: &'static str) -> R<&'a str> {
    let m = obj(v, code)?;
    exact_keys(m, &["code", "reason"], code)?;
    let c = ascii_str(m.get("code"), code)?;
    if !code_list.contains(&c) {
        return Err(bad(code));
    }
    let want = reason_of(c).ok_or_else(|| bad(code))?;
    if m.get("reason").and_then(Value::as_str) != Some(want.as_str()) {
        return Err(bad(code));
    }
    Ok(c)
}

/// Passport source order for the fund type: bank, the manager or servicer records, issuer claims.
fn passport_sources(kind: &str) -> [(&'static str, u64, &'static str, &'static str); 3] {
    let mgr = if kind == "credit" { "servicer_records" } else { "property_manager_records" };
    [("bank_settlements", 3, "third_party_bank", "daily"), (mgr, 2, "issuer_appointed_manager", "monthly"), ("issuer_claims", 1, "issuer", "monthly")]
}

/// Check one receipt (the parsed OutLayer output) against the pending request. Ok gives the indexed summary.
pub fn check(v: &Value, e: &Expect) -> R<Summary> {
    let m = obj(v, "not_an_object")?;
    exact_keys(m, &TOP, "top_fields")?;
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
    let period = ascii_str(m.get("period"), "period_or_as_of")?;
    let as_of = ascii_str(m.get("as_of"), "period_or_as_of")?;
    if !is_period(period) || !is_utc_ts(as_of) {
        return Err(bad("period_or_as_of"));
    }

    // score: parts sum to raw, uncapped is raw rounded, caps hold at 59 and holds at 84, band follows the score
    let parts = obj(&m["parts_x100"], "parts_x100")?;
    exact_keys(parts, &["cash_match", "freshness", "gap", "late"], "parts_x100")?;
    let mut raw = 0;
    for (k, max) in [("cash_match", 4_000), ("gap", 2_500), ("late", 1_500), ("freshness", 2_000)] {
        raw += int_in(parts.get(k), 0, max, "parts_x100")?;
    }
    if int_in(m.get("raw_x100"), 0, 10_000, "raw_x100")? != raw {
        return Err(bad("raw_x100"));
    }
    let uncapped = int_in(m.get("uncapped_score"), 0, 100, "uncapped_score")?;
    if uncapped != rhu(raw, 100) {
        return Err(bad("uncapped_score"));
    }
    let score = int_in(m.get("score"), 0, 100, "score")?;
    if m["band"].as_str() != Some(band_for(score as u64)) {
        return Err(bad("band"));
    }

    let ((status, shortfall, rate, c_period, cutoff), ex) = check_metrics(&m["metrics"], e.kind, period)?;
    let caps_v = arr(&m["caps"], "caps")?;
    let mut caps: Vec<String> = vec![];
    for c in caps_v {
        let code = coded(c, &CAPS.map(|x| x.0), |k| cap_reason(k, rate, &c_period, &cutoff), "caps")?;
        if caps.iter().any(|x| x == code) {
            return Err(bad("caps"));
        }
        caps.push(code.to_string());
    }
    let mut holds: Vec<String> = vec![];
    for h in arr(&m["holds"], "holds")? {
        let code = coded(h, &HOLDS.map(|x| x.0), |k| HOLDS.iter().find(|x| x.0 == k).map(|x| x.1.to_string()), "holds")?;
        holds.push(code.to_string());
    }
    // the collection outcome decides collection_shortfall and the holds, exactly
    let has_shortfall = caps.iter().any(|c| c == "collection_shortfall");
    let want_holds: Vec<&str> = match status {
        "pending" => vec!["collection_pending"],
        "not_applicable" => vec!["collection_not_applicable"],
        _ => vec![],
    };
    if has_shortfall != (status == "verified" && shortfall) || holds != want_holds {
        return Err(bad("collection_outcome"));
    }
    let mut want = uncapped;
    if !caps.is_empty() {
        want = want.min(59);
    }
    if !holds.is_empty() {
        want = want.min(84);
    }
    if score != want {
        return Err(bad("cap_not_applied"));
    }

    // passport and evidence hashes: one entry per source, in order, whole-document sha256
    let passport = arr(&m["passport"], "passport")?;
    let want_src = passport_sources(e.kind);
    if passport.len() != want_src.len() {
        return Err(bad("passport"));
    }
    let mut missing: Vec<String> = vec![];
    for (p, (src, tier, indep, cadence)) in passport.iter().zip(want_src) {
        let p = obj(p, "passport")?;
        exact_keys(p, &PASSPORT_KEYS, "passport")?;
        let ok = p.get("source").and_then(Value::as_str) == Some(src)
            && p.get("tier").and_then(Value::as_u64) == Some(tier)
            && p.get("independence").and_then(Value::as_str) == Some(indep)
            && p.get("cadence").and_then(Value::as_str) == Some(cadence)
            && p.get("as_of").and_then(Value::as_str).is_some_and(is_utc_ts)
            && p.get("synthetic").is_some_and(Value::is_boolean)
            && p.get("age_hours").and_then(Value::as_u64).is_some()
            && p.get("method_version").and_then(Value::as_str) == Some(e.method);
        if !ok {
            return Err(bad("passport"));
        }
        if !p.get("snapshot_sha256").and_then(Value::as_str).is_some_and(is_hex64) {
            return Err(bad("passport_hash"));
        }
        let carried = p.get("carried_forward").and_then(Value::as_bool).ok_or_else(|| bad("passport"))?;
        let fresh = int_in(p.get("freshness_bps"), 0, 10_000, "passport")?;
        if carried || fresh == 0 {
            missing.push(format!("{src}_stale_or_carried_forward"));
        }
    }
    let ev = arr(&m["evidence_hashes"], "evidence_hashes")?;
    if ev.len() != passport.len() {
        return Err(bad("evidence_hashes"));
    }
    for (x, p) in ev.iter().zip(passport) {
        let x = obj(x, "evidence_hashes")?;
        exact_keys(x, &["sha256", "source"], "evidence_hashes")?;
        if x.get("source") != p.get("source") || x.get("sha256") != p.get("snapshot_sha256") {
            return Err(bad("evidence_hashes"));
        }
    }
    let checks = arr(&m["checks_run"], "checks_run")?;
    if checks.len() != CHECKS.len() || checks.iter().zip(CHECKS).any(|(c, w)| c.as_str() != Some(w)) {
        return Err(bad("checks_run"));
    }
    // exceptions: exactly the non-zero counts of the metrics block, in its order
    let want_ex: Vec<(&str, i64)> = EXCEPTIONS.iter().filter_map(|k| ex.get(*k).and_then(Value::as_i64).filter(|n| *n > 0).map(|n| (*k, n))).collect();
    let got_ex = arr(&m["exceptions"], "exceptions")?;
    if got_ex.len() != want_ex.len() {
        return Err(bad("exceptions"));
    }
    for x in got_ex {
        let x = obj(x, "exceptions")?;
        exact_keys(x, &["code", "count"], "exceptions")?;
        let pair = (ascii_str(x.get("code"), "exceptions")?, int_in(x.get("count"), 1, MAX_SAFE, "exceptions")?);
        if !want_ex.contains(&pair) {
            return Err(bad("exceptions"));
        }
    }
    let got_missing = arr(&m["missing_evidence"], "missing_evidence")?;
    if got_missing.len() != missing.len() || got_missing.iter().zip(&missing).any(|(g, w)| g.as_str() != Some(w.as_str())) {
        return Err(bad("missing_evidence"));
    }
    if !m["synthetic"].is_boolean() {
        return Err(bad("synthetic"));
    }
    if !m["receipt_sha256"].as_str().is_some_and(is_hex64) {
        return Err(bad("receipt_sha256"));
    }
    Ok(Summary { score: score as u64, band: band_for(score as u64).to_string(), period: period.to_string(), as_of: as_of.to_string(), caps, holds })
}

/// A failure stage printed by the module: a short code of lowercase letters, digits and underscores.
pub fn is_stage(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
}
