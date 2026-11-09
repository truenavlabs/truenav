//! The v3 pipeline. Financial inputs are read only after four scoped signatures pass.
//! RegistryReader and Fingerprinter are trusted host capabilities, never issuer payloads.
use crate::nav::{self, Nav};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use truenav_engine_v2::{
    base::Pseudonymizer,
    run::{run_fund, RunOptions},
};
use truenav_v3_core::source::*;
use truenav_v3_core::{timestamp, validate, Result};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Context {
    pub scope: Scope,
    pub period: Period,
    pub seq: String,
    pub prev_receipt_sha256: Option<String>,
    pub supersedes_seq: Option<String>,
    pub correction_reason_code: Option<String>,
    pub request_id: String,
    pub request_nonce: String,
    pub engine_version_key: String,
    pub engine_code_sha256: String,
    pub valuation_time: String,
    pub issued_at: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LockRead {
    pub fingerprint: String,
    pub completed: bool,
    pub owner: Option<String>,
    pub fund_token_id: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    pub registry_account: String,
    pub block_height: String,
    pub block_hash: String,
    pub finalized: bool,
    pub manager_id: String,
    pub locks: Vec<LockRead>,
    pub attempts: Value,
    pub certificate_history: Value,
    /// Complete authenticated roster, used for R10. Host must reject incomplete pagination.
    pub manager_funds: Vec<Value>,
    pub manager_attempt_log: Value,
}
pub trait RegistryReader {
    fn read(
        &self,
        scope: &Scope,
        fingerprints: &[String],
        valuation_time: &str,
    ) -> Result<Snapshot>;
}
pub struct Policy {
    pub source_registry: Registry,
    pub minimum_revisions: BTreeMap<String, u64>,
    pub case_sensitive_namespaces: Vec<String>,
    pub previous_cash_passport: Vec<(String, String, String)>,
    pub previous_period: Option<String>,
}
pub struct Output {
    pub envelope: Value,
    pub private_report: Value,
}

/// Integer-only 1-2-5 ladder, signed cents, ties away from zero.
pub fn round_nav(cents: i128) -> Result<i128> {
    let x = cents.checked_abs().ok_or("nav_range")?;
    let target = 1_000_000i128.max(x / 1000 + i128::from(x % 1000 != 0));
    let mut power = 100i128;
    let step = loop {
        let mut found = None;
        for m in [1i128, 2, 5] {
            let s = power.checked_mul(m).ok_or("nav_range")?;
            if s >= target {
                found = Some(s);
                break;
            }
        }
        if let Some(s) = found {
            break s;
        }
        power = power.checked_mul(10).ok_or("nav_range")?;
    };
    let q = x / step;
    let r = x % step;
    let rounded = (q + i128::from(r >= step / 2 + step % 2))
        .checked_mul(step)
        .ok_or("nav_range")?;
    if cents < 0 {
        rounded.checked_neg().ok_or("nav_range")
    } else {
        Ok(rounded)
    }
}
fn cents(dollars: f64) -> Result<String> {
    if !dollars.is_finite() || dollars.abs() > 90_071_992_547_409.0 {
        return Err("nav_range");
    }
    Ok((dollars * 100.0).round().to_string())
}
pub fn count_band(n: usize) -> &'static str {
    match n {
        0 => "zero",
        1..=4 => "lt_5",
        5..=9 => "from_5_to_9",
        10..=19 => "from_10_to_19",
        20..=49 => "from_20_to_49",
        _ => "gte_50",
    }
}
pub fn coverage_bps(completed: usize, total: usize) -> Option<u64> {
    if total == 0 {
        return None;
    }
    let floor = if completed < 10 { 2500 } else { 100 };
    Some((completed.min(total) as u64 * 10000 / total as u64) / floor * floor)
}
fn positive_part(x: f64, max: f64) -> &'static str {
    if x == 0.0 {
        "none"
    } else if x < max * 0.5 {
        "low"
    } else if x < max * 0.85 {
        "medium"
    } else {
        "high"
    }
}
fn penalty_part(x: f64) -> &'static str {
    if x == 0.0 {
        "none"
    } else if x < 5.0 {
        "low"
    } else if x < 15.0 {
        "medium"
    } else {
        "high"
    }
}
fn share(x: Option<f64>, late: bool) -> &'static str {
    match x {
        None => "unknown",
        Some(x) if x <= 0.0 => "zero",
        Some(x) if x <= 0.1 => "gt_0_lte_10pct",
        Some(x) if x <= 0.25 => "gt_10_lte_25pct",
        Some(_) if late => "gt_25pct",
        Some(x) if x <= 0.5 => "gt_25_lte_50pct",
        _ => "gt_50pct",
    }
}
fn coh(n: usize) -> Value {
    if n == 0 {
        json!("zero")
    } else if n < 5 {
        json!("lt_5")
    } else {
        json!(n)
    }
}
/// Complementary suppression prevents a single small cell being subtracted from a total.
fn cohorts(nav: &Nav) -> Value {
    let mut cells = [0usize; 4];
    for l in nav.lines.iter().filter(|l| l.open) {
        match l.bucket.as_str() {
            "dpd_1_30" => cells[0] += 1,
            "dpd_31_60" => cells[1] += 1,
            "dpd_61_90" => cells[2] += 1,
            "dpd_over_90" => cells[3] += 1,
            _ => {}
        }
    }
    let mut out: Vec<_> = cells.iter().map(|&n| coh(n)).collect();
    if cells.iter().any(|&n| n > 0 && n < 5) {
        for i in 0..4 {
            if cells[i] == 0 || cells[i] >= 5 {
                out[i] = json!("suppressed")
            }
        }
    }
    json!({"dpd_1_30":out[0],"dpd_31_60":out[1],"dpd_61_90":out[2],"dpd_91_plus":out[3]})
}
fn blank(c: &Context) -> Value {
    json!({
     "receipt_version":"3","method_version":truenav_v3_core::wire::CURRENT_METHOD,"method_spec_sha256":truenav_v3_core::wire::method_hash_for(truenav_v3_core::wire::CURRENT_METHOD).expect("current artifact"),"network":c.scope.network,"receipts_contract":c.scope.receipts_contract,"currency":"USD","engine_version_key":c.engine_version_key,"engine_code_sha256":c.engine_code_sha256,
     "token_id":c.scope.token_id,"fund_id":c.scope.fund_id,"fund_account":c.scope.fund_account,"kind":"credit","period_start":c.period.period_start,"period_end":c.period.period_end,"seq":c.seq,"prev_receipt_sha256":c.prev_receipt_sha256,"supersedes_seq":c.supersedes_seq,"correction_reason_code":c.correction_reason_code,"issued_at":c.issued_at,"data_as_of":null,"valuation_time":c.valuation_time,"request_id":c.request_id,"request_nonce":c.request_nonce,"synthetic":true,"input_sha256":"","receipt_sha256":"","attestation_ref":null,"source_key_ids":[],"commitments":{},
     "pledge_scope":{"registry_account":"registry.tnlab-718ca9.testnet","block_height":"0","block_hash":"unavailable","scope_id":"loan-terms-v2:first-lien","coverage_status":"unknown"},"fingerprint_scheme":"loan-terms-v2","pledge_result":"unknown","pledge_coverage_bps":null,"loans_checked":"unknown","blocked_attempts":"unknown","blocked_attempts_window":"period_to_valuation","lien_support":"first_lien_only",
     "reported_nav":null,"trueval":null,"truerange_low":null,"truerange_high":null,"nav_result":"unknown","nav_gap_band":"unknown","unverified_share_band":"unknown","cash_evidence_status":"invalid","cash_match_band":"unknown","yield_gap_band":"unknown","collection_rate_band":"unknown","late_share_band":"unknown","late_loan_cohorts":{"dpd_1_30":"unknown","dpd_31_60":"unknown","dpd_61_90":"unknown","dpd_91_plus":"unknown"},"exceptions":[],"status":"verification_failed","score":null,"band":"red","parts_band":{"coverage":"unknown","nav_gap":"unknown","freshness":"unknown","penalty":"unknown"},"caps":[],"holds":[],"freshness_band":"unknown","ext":{}
    })
}
fn seal(
    mut e: Value,
    mut report: Value,
    inputs: &Value,
    nonce: &[u8; 32],
    salt: &[u8; 32],
) -> Result<Output> {
    // The report includes exact evidence and salt. It never enters public stdout.
    report["classification"] = json!("PRIVATE synthetic full report");
    report["report_version"] = json!(truenav_v3_core::wire::CURRENT_METHOD);
    report["certificate_salt"] = json!(hex::encode(salt));
    report["request_nonce"] = json!(hex::encode(nonce));
    let mut cs = json!({});
    for (key, label) in [
        ("tape", "tape"),
        ("cash", "cash"),
        ("nav_report", "nav_report"),
        ("pledge_detail", "pledge_detail"),
        ("registry_state_root", "registry_state_root"),
        ("reported_nav", "nav_exact:reported_nav"),
        ("trueval", "nav_exact:trueval"),
        ("truerange_low", "nav_exact:truerange_low"),
        ("truerange_high", "nav_exact:truerange_high"),
        ("score_x100", "score_exact:score_x100"),
        ("parts_x100", "score_exact:parts_x100"),
        ("raw_score", "score_exact:raw_score"),
    ] {
        let value = if label.starts_with("nav_exact:") {
            if report["exact"][key].is_null() {
                Value::Null
            } else {
                json!({"currency":"USD","cents":report["exact"][key]})
            }
        } else {
            report[key].clone()
        };
        cs[key] = json!(commitment(label, &value, nonce, salt)?)
    }
    report["input_manifest"] = json!({"schema_version":"truenav-input-manifest-v3","currency":"USD","sources":inputs,"registry_state_root":report["registry_state_root"],"policy":report["policy"]});
    cs["full_report"] = json!(commitment("full_report", &report, nonce, salt)?);
    e["commitments"] = cs;
    e["input_sha256"] = json!(commitment(
        "inputs",
        &report["input_manifest"],
        nonce,
        salt
    )?);
    truenav_v3_core::wire::seal_envelope(&mut e)?;
    #[cfg(not(feature = "dry-run-tests"))]
    validate(&e)?;
    #[cfg(feature = "dry-run-tests")]
    if e["receipts_contract"] == "receipts.tnlab-718ca9.testnet" {
        validate(&e)?
    } else {
        truenav_v3_core::wire::validate_dry_run(&e, true)?
    }
    Ok(Output {
        envelope: e,
        private_report: report,
    })
}
struct CashMac<'a>(&'a dyn Fingerprinter);
impl Pseudonymizer for CashMac<'_> {
    fn mac32(&self, msg: &[u8]) -> std::result::Result<Vec<u8>, String> {
        self.0.mac(msg).map(|x| x.to_vec()).map_err(str::to_string)
    }
}

/// Tape dollars to integer cents from decimal text. No f64 multiply.
/// A JSON number is taken from its decimal rendering. Exponents are refused.
/// After half-away-from-zero rounding to cents, the absolute value must be below 2^53.
pub(crate) fn tape_principal_cents(v: &Value) -> Option<i128> {
    let text = match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => return None,
    };
    let s = text.trim();
    if s.is_empty()
        || s.starts_with('+')
        || s.starts_with('-')
        || s.contains(['e', 'E'])
        || s.ends_with('.')
    {
        return None;
    }
    let (whole, frac) = match s.split_once('.') {
        Some((w, f)) => (w, f),
        None => (s, ""),
    };
    if whole.is_empty()
        || !whole.bytes().all(|c| c.is_ascii_digit())
        || !frac.bytes().all(|c| c.is_ascii_digit())
    {
        return None;
    }
    let whole_n: i128 = whole.parse().ok()?;
    let mut padded = frac.to_string();
    while padded.len() < 3 {
        padded.push('0');
    }
    let head: i128 = padded[..2].parse().ok()?;
    let round_up = padded.as_bytes()[2] >= b'5';
    let mut cents = whole_n.checked_mul(100)?.checked_add(head)?;
    if round_up {
        cents = cents.checked_add(1)?;
    }
    if cents.unsigned_abs() >= (1u128 << 53) {
        return None;
    }
    Some(cents)
}
pub fn evaluate(
    c: &Context,
    sources: &[SignedSource],
    policy: &Policy,
    reader: &dyn RegistryReader,
    mac: &dyn Fingerprinter,
    salt: &[u8; 32],
) -> Result<Output> {
    if c.scope.fund_id.is_empty() {
        return Err("source_scope_mismatch");
    }
    policy.source_registry.check()?;
    let nonce: [u8; 32] = hex::decode(&c.request_nonce)
        .map_err(|_| "request_nonce")?
        .try_into()
        .map_err(|_| "request_nonce")?;
    let now = timestamp(&c.valuation_time)?;
    if timestamp(&c.issued_at)? < now {
        return Err("clock_order");
    }
    if sources.len() != 4 {
        return Err("source_roles");
    }
    let mut ordered = Vec::new();
    let mut roles = BTreeSet::new();
    let mut rows = Vec::new();
    let mut errors = BTreeSet::new();
    for role in ["servicer", "bank", "fund_admin", "custodian"] {
        let found: Vec<_> = sources.iter().filter(|s| s.source == role).collect();
        if found.len() != 1 || !roles.insert(role) {
            return Err("source_roles");
        }
        let s = found[0];
        let result = verify_source(
            s,
            &policy.source_registry,
            &c.scope,
            &c.period,
            *policy
                .minimum_revisions
                .get(role)
                .ok_or("revision_policy_missing")?,
        );
        // An unknown identifier is untrusted text and must not become a public provenance field.
        if result == Err("source_key_unknown") {
            return Err("source_key_unknown");
        }
        if let Err(code) = result {
            errors.insert(code);
        } else if timestamp(&s.data_as_of)? > now + 600_000 {
            errors.insert("source_signature_invalid");
        }
        rows.push(json!({"source":s.source,"key_id":s.key_id,"sig_ok":result.is_ok()&&timestamp(&s.data_as_of)?<=now+600_000}));
        ordered.push(s);
    }
    let inputs = serde_json::to_value(sources).map_err(|_| "source_serialization")?;
    let mut e = blank(c);
    e["source_key_ids"] = json!(rows);
    if !errors.is_empty() {
        errors.insert("source_signature_invalid");
        e["holds"] = json!(errors);
        return seal(
            e,
            json!({"rejected":true,"raw_score":null,"score_x100":null,"parts_x100":null,"exact":null,"tape":null,"cash":null,"nav_report":null,"pledge_detail":null,"registry_state_root":null}),
            &inputs,
            &nonce,
            salt,
        );
    }
    let servicer = &ordered[0].payload;
    let bank = &ordered[1].payload;
    let admin = &ordered[2].payload;
    let custodian = &ordered[3].payload;
    let mut fund = admin["fund"].clone();
    if fund.get("kind").is_some_and(|k| k != "credit") {
        return Err("dataset_kind");
    }
    if !fund.is_object() || fund["fund_id"] != c.scope.token_id {
        return Err("source_scope_mismatch");
    }
    let loans = servicer["loans"].as_array().ok_or("loan_tape_invalid")?;
    if loans.len() > 10000 {
        return Err("loan_tape_limit");
    }
    let terms = custodian["loan_terms"]
        .as_array()
        .ok_or("loan_terms_missing")?;
    if terms.len() != loans.len() {
        return Err("loan_terms_missing");
    }
    let mut seen = BTreeSet::new();
    let mut prepared = Vec::new();
    let mut fingerprints = Vec::new();
    let mut ranks = Vec::new();
    for loan in loans {
        let id = loan["id"]
            .as_str()
            .filter(|x| !x.is_empty())
            .ok_or("loan_tape_invalid")?;
        if !seen.insert(id) {
            return Err("loan_tape_duplicate");
        }
        let matched: Vec<_> = terms.iter().filter(|t| t["loan_id"] == id).collect();
        if matched.len() != 1 {
            return Err("loan_terms_missing");
        }
        let row = matched[0];
        let rank = row["lien_rank"]
            .as_u64()
            .filter(|x| *x > 0)
            .ok_or("loan_terms_invalid")?;
        let t: LoanTerms =
            serde_json::from_value(row["terms"].clone()).map_err(|_| "loan_terms_invalid")?;
        if canonical_terms(&t, &policy.case_sensitive_namespaces)? != row["terms"] {
            return Err("loan_terms_not_canonical");
        }
        // Terms must also be inside the servicer-signed loan row, preventing custodian substitution.
        if loan["terms"] != row["terms"] || loan["lien_rank"] != rank {
            return Err("loan_terms_scope_mismatch");
        }
        let asset = loan["asset"].as_str().ok_or("loan_terms_invalid")?;
        let fp = fingerprint(&t, asset, &policy.case_sensitive_namespaces, mac)?;
        prepared.push(loan.clone());
        fingerprints.push(fp);
        ranks.push(rank);
    }
    let mut queried = fingerprints.clone();
    for loan in &prepared {
        let t: LoanTerms =
            serde_json::from_value(loan["terms"].clone()).map_err(|_| "loan_terms_invalid")?;
        let asset = loan["asset"].as_str().ok_or("loan_terms_invalid")?;
        for h in pledge_lookup_hashes(&t, asset, &policy.case_sensitive_namespaces, mac)? {
            if !queried.contains(&h) {
                queried.push(h);
            }
        }
    }
    let snapshot = reader.read(&c.scope, &queried, &c.valuation_time)?;
    if !snapshot.finalized
        || snapshot.registry_account != "registry.tnlab-718ca9.testnet"
        || snapshot.block_height.parse::<u64>().is_err()
        || snapshot.block_hash.is_empty()
    {
        return Err("registry_snapshot_invalid");
    }
    let mut reads = BTreeMap::new();
    for lock in &snapshot.locks {
        if !fingerprints.contains(&lock.fingerprint)
            || reads.insert(lock.fingerprint.clone(), lock).is_some()
        {
            return Err("registry_snapshot_invalid");
        }
    }
    let mut completed = 0usize;
    let mut total = 0usize;
    let mut conflict = false;
    let mut terms_mismatch = false;
    let mut incomplete = false;
    let mut second = false;
    let mut pledge_detail = Vec::new();
    let mut distinct = BTreeSet::new();
    for (i, loan) in prepared.iter_mut().enumerate() {
        let open = match (
            loan["principal"].as_f64(),
            loan["accrued"].as_f64(),
            loan["repaid"].as_f64(),
        ) {
            (Some(p), Some(a), Some(r)) => p + a - r != 0.0,
            _ => true,
        };
        let read = reads.get(&fingerprints[i]);
        let done = read.is_some_and(|r| r.completed);
        let owner = read.and_then(|r| r.owner.as_deref());
        let dup = !distinct.insert(&fingerprints[i]);
        if open && dup {
            return Err("loan_terms_duplicate");
        }
        let own = done
            && owner == Some(c.scope.fund_account.as_str())
            && read.is_some_and(|r| r.fund_token_id.as_deref() == Some(&c.scope.token_id));
        // A foreign lock is a double pledge even when the tape balance is zero.
        if done && owner.is_some() && !own {
            conflict = true
        }
        if open {
            total += 1;
            if done {
                completed += 1
            }
            if ranks[i] >= 2 {
                second = true
            }
            let signed: Option<LoanTerms> = serde_json::from_value(loan["terms"].clone()).ok();
            let tape_cents = tape_principal_cents(&loan["principal"]);
            let signed_cents = signed
                .as_ref()
                .and_then(|t| t.principal_cents.parse::<i128>().ok());
            if tape_cents != signed_cents {
                terms_mismatch = true
            }
            if let Some(t) = signed.as_ref() {
                if loan["origination_date"]
                    .as_str()
                    .is_some_and(|d| d != t.origination_date)
                {
                    terms_mismatch = true
                }
            }
            if !done || owner.is_none() || dup {
                incomplete = true
            }
        }
        loan["nft"] = json!(own && ranks[i] == 1 && !dup);
        loan["nft_id"] = json!(fingerprints[i]);
        loan["anomaly"] = json!(loan["anomaly"] == true || !own || ranks[i] >= 2 || dup);
        pledge_detail.push(json!({"loan_id":loan["id"],"fingerprint":fingerprints[i],"lien_rank":ranks[i],"completed":done,"owner":owner}));
    }
    if fund["cash_attested"] == true {
        let balance = bank["balance_cents"]
            .as_str()
            .and_then(|s| s.parse::<i128>().ok());
        let claimed = fund["cash"]
            .as_f64()
            .and_then(|x| cents(x).ok())
            .and_then(|s| s.parse::<i128>().ok());
        if balance.is_none() || balance != claimed || bank["balance_as_of"] != fund["cash_asof"] {
            return Err("cash_attestation_unbound");
        }
    }
    fund["registry_manager_id"] = json!(snapshot.manager_id);
    fund["source_data_asof"] = json!(ordered
        .iter()
        .map(|s| s.data_as_of.as_str())
        .min_by_key(|s| timestamp(s).unwrap_or(i64::MIN)));
    fund["loans"] = json!(prepared);
    // Only a finalized registry read supplies attempt events. Reject future and malformed events.
    let mut actionids = BTreeSet::new();
    let mut attempts = Vec::new();
    let mut period_attempts = 0;
    let period_start = timestamp(&format!("{}T00:00:00Z", c.period.period_start))?;
    for event in snapshot
        .attempts
        .as_array()
        .ok_or("registry_attempts_invalid")?
    {
        let aid = event["action_id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("registry_attempts_invalid")?;
        let at = timestamp(event["at"].as_str().ok_or("registry_attempts_invalid")?)?;
        if at > now {
            return Err("registry_attempts_invalid");
        }
        if actionids.insert(aid) {
            if at >= period_start {
                period_attempts += 1
            }
            attempts.push(json!({"action_id":aid,"age_days":(now-at)as f64/86_400_000.0}));
        }
    }
    fund["blocked_attempts"] = json!(attempts);
    let mut all = vec![fund.clone()];
    for sibling in &snapshot.manager_funds {
        if sibling["fund_id"] != c.scope.token_id {
            all.push(sibling.clone())
        }
    }
    let mut histories = json!({});
    histories[c.scope.token_id.clone()] = snapshot.certificate_history.clone();
    let nav = nav::portfolio(&all, now, &histories, &snapshot.manager_attempt_log).remove(0);
    let ds = json!({"id":c.scope.token_id,"kind":"credit","synthetic":true,"bank_feed":bank,"servicer_tape":servicer["cashflow"],"issuer":admin["issuer"]});
    let period = c.period.period_start.get(..7).ok_or("period_invalid")?;
    let end = timestamp(&format!("{}T00:00:00Z", c.period.period_end))?;
    let days = (end - period_start) / 86_400_000;
    let bank_asof = [
        ordered[1].data_as_of.as_str(),
        bank["as_of"].as_str().unwrap_or(&ordered[1].data_as_of),
    ]
    .into_iter()
    .min_by_key(|s| timestamp(s).unwrap_or(i64::MIN))
    .ok_or("cash_evidence_invalid")?;
    let cash = run_fund(
        &ds,
        &CashMac(mac),
        &RunOptions {
            as_of: &c.valuation_time,
            period,
            days_in_period: days,
            bank_fetched_at: bank_asof,
            previous: policy.previous_cash_passport.clone(),
            new_period: policy
                .previous_period
                .as_deref()
                .is_some_and(|p| p != period),
        },
    )
    .map_err(|_| "cash_evidence_invalid")?;
    let mut caps: Vec<_> = cash.score["caps"]
        .as_array()
        .ok_or("cash_evidence_invalid")?
        .iter()
        .map(|v| v["code"].as_str().ok_or("cash_evidence_invalid"))
        .collect::<Result<_>>()?;
    if caps.iter().any(|x| {
        ![
            "self_reported_only",
            "yield_gap",
            "distribution_funded_by_sponsor",
            "claimed_not_settled",
            "collection_shortfall",
        ]
        .contains(x)
    }) {
        return Err("cash_cap_unknown");
    }
    if conflict {
        caps.push("pledge_conflict");
    }
    let mut holds = Vec::new();
    for h in cash.score["holds"]
        .as_array()
        .ok_or("cash_evidence_invalid")?
    {
        holds.push(
            h["code"]
                .as_str()
                .ok_or("cash_evidence_invalid")?
                .to_string(),
        )
    }
    if nav.recent {
        holds.push("recent_pledge_attempt".into())
    }
    if second {
        holds.push("second_lien_unsupported".into())
    }
    if completed < total {
        holds.push("registry_read_incomplete".into())
    }
    if nav.concentration_largest {
        holds.push("concentration_largest_obligor".into())
    }
    if nav.concentration_five {
        holds.push("concentration_top_five".into())
    }
    if nav.lines.iter().all(|l| !l.verified) {
        holds.push("no_verified_loans".into())
    }
    if nav.unknown_exposure {
        holds.push("unverified_exposure_unknown".into())
    }
    if nav.unverified_share.is_some_and(|x| x > 0.5) {
        holds.push("unverified_exposure_majority".into())
    }
    let final_score = nav.raw.max(0.0).min(if caps.is_empty() && !terms_mismatch {
        100.0
    } else {
        59.0
    });
    let scored = nav.status == "scored";
    let score = nav::half_up(final_score);
    // R12 and collection holds close green. Concentration is disclosed, not a score cap.
    let yellow_hold = nav.recent
        || holds
            .iter()
            .any(|h| ["collection_pending", "collection_not_applicable"].contains(&h.as_str()));
    let band = if conflict || terms_mismatch {
        "red"
    } else if scored {
        if score >= 85 && !yellow_hold {
            "green"
        } else if score >= 60 {
            "yellow"
        } else {
            "red"
        }
    } else if nav.status == "not_rated" {
        "grey"
    } else {
        "red"
    };
    e["status"] = json!(nav.status);
    e["score"] = if scored { json!(score) } else { Value::Null };
    e["band"] = json!(band);
    e["caps"] = json!(caps);
    e["holds"] = json!(holds);
    e["exceptions"] = json!(if terms_mismatch {
        vec![json!({"code":"terms_mismatch","band":"material"})]
    } else {
        Vec::<Value>::new()
    });
    e["data_as_of"] = json!(nav.data_as_of);
    e["pledge_scope"] = json!({"registry_account":snapshot.registry_account,"block_height":snapshot.block_height,"block_hash":snapshot.block_hash,"scope_id":"loan-terms-v2:first-lien","coverage_status":if total==0{"unknown"}else if completed==total{"complete"}else{"partial"}});
    e["pledge_result"] = json!(if conflict {
        "conflict"
    } else if second {
        "unknown"
    } else if incomplete || total == 0 {
        "incomplete"
    } else {
        "clear"
    });
    e["pledge_coverage_bps"] = json!(coverage_bps(completed, total));
    e["loans_checked"] = json!(count_band(completed));
    e["blocked_attempts"] = json!(match period_attempts {
        0 => "zero",
        1 => "one",
        _ => "two_plus",
    });
    let exact = json!({"reported_nav":cents(nav.headline)?,"trueval":cents(nav.trueval)?,"truerange_low":cents(nav.low)?,"truerange_high":cents(nav.high)?});
    for key in ["reported_nav", "trueval", "truerange_low", "truerange_high"] {
        e[key] = if scored {
            json!(round_nav(
                exact[key]
                    .as_str()
                    .unwrap()
                    .parse()
                    .map_err(|_| "nav_range")?
            )?
            .to_string())
        } else {
            Value::Null
        }
    }
    let result = if nav.over > 0.0 && nav.under > 0.0 {
        "outside_both"
    } else if nav.over > 0.0 {
        "outside_high"
    } else if nav.under > 0.0 {
        "outside_low"
    } else {
        "inside"
    };
    let gap = nav.over.max(nav.under) / nav.trueval;
    e["nav_result"] = json!(if scored { result } else { "unknown" });
    e["nav_gap_band"] = json!(if !scored || nav.trueval <= 0.0 {
        "unknown"
    } else if gap == 0.0 {
        "inside"
    } else if gap <= 0.05 {
        "gt_0_lte_5pct"
    } else if gap <= 0.1 {
        "gt_5_lte_10pct"
    } else {
        "gt_10pct"
    });
    e["unverified_share_band"] = json!(share(nav.unverified_share, false));
    let age = nav
        .data_as_of
        .as_deref()
        .and_then(|t| timestamp(t).ok())
        .map(|t| ((now - t) as f64 / 3_600_000.0).max(0.0));
    e["freshness_band"] = json!(match age {
        None => "unknown",
        Some(x) if x <= 24.0 => "lte_24h",
        Some(x) if x <= 72.0 => "gt_24_lte_72h",
        Some(x) if x <= 168.0 => "gt_72_lte_168h",
        _ => "gt_168h",
    });
    e["parts_band"] = if scored {
        json!({"coverage":positive_part(nav.coverage,40.0),"nav_gap":positive_part(nav.gap,40.0),"freshness":positive_part(nav.fresh,20.0),"penalty":penalty_part(nav.penalty)})
    } else {
        json!({"coverage":"unknown","nav_gap":"unknown","freshness":"unknown","penalty":"unknown"})
    };
    let mt = &cash.metrics;
    let cash_match = mt["cash_match_bps"]
        .as_i64()
        .ok_or("cash_evidence_invalid")?;
    let yield_gap = admin["issuer"]["reported_yield_bps"]
        .as_i64()
        .ok_or("cash_evidence_invalid")?
        - mt["cash_yield_bps"]
            .as_i64()
            .ok_or("cash_evidence_invalid")?;
    e["cash_evidence_status"] = json!(if caps.contains(&"self_reported_only") {
        "stale"
    } else {
        "verified"
    });
    e["cash_match_band"] = json!(if cash_match < 9000 {
        "lt_90pct"
    } else if cash_match < 9800 {
        "gte_90_lt_98pct"
    } else {
        "gte_98_lte_100pct"
    });
    e["yield_gap_band"] = json!(if yield_gap < 0 {
        "lt_0pp"
    } else if yield_gap < 300 {
        "gte_0_lt_3pp"
    } else {
        "gte_3pp"
    });
    e["collection_rate_band"] = json!(match mt["collection"]["status"].as_str() {
        Some("verified") =>
            if mt["collection"]["rate_bps"].as_i64().unwrap_or(0) < 9000 {
                "lt_90pct"
            } else {
                "gte_90pct"
            },
        Some("pending") => "pending",
        Some("not_applicable") => "no_dues",
        _ => "unknown",
    });
    let exposure: f64 = nav.lines.iter().filter(|l| l.open).map(|l| l.ead).sum();
    let late: f64 = nav
        .lines
        .iter()
        .filter(|l| l.open && ["dpd_61_90", "dpd_over_90"].contains(&l.bucket.as_str()))
        .map(|l| l.ead)
        .sum();
    e["late_share_band"] = json!(share(
        if exposure > 0.0 {
            Some(late / exposure)
        } else {
            None
        },
        true
    ));
    e["late_loan_cohorts"] = cohorts(&nav);
    let mut report = json!({"currency":"USD","exact":exact,"nav_diagnostics":nav.private_json()});
    report["tape"] = json!({"schema_version":"truenav-servicer-v3","currency":"USD","nav_money_unit":"dollars","cash_money_unit":"cents","payload":servicer});
    report["cash"] = json!({"schema_version":"truenav-cash-evidence-v3","currency":"USD","money_unit":"cents","bank":bank,"issuer":admin["issuer"],"metrics":mt,"matched":cash.matched,"passport":cash.passport});
    report["nav_report"] = json!({"schema_version":"truenav-fund-admin-v3","currency":"USD","nav_money_unit":"dollars","payload":admin});
    report["pledge_detail"] = json!({"schema_version":"truenav-pledge-detail-v3","fingerprint_scheme":"loan-terms-v2","loans":pledge_detail});
    let manifest = json!({"schema_version":"truenav-registry-read-manifest-v3","snapshot":serde_json::to_value(&snapshot).map_err(|_|"registry_snapshot_invalid")?});
    let root = truenav_v3_core::hash(truenav_v3_core::canonical(&manifest)?.as_bytes());
    report["private_registry_state_root"] = json!(root);
    report["registry_read_manifest"] = manifest;
    report["registry_state_root"] = json!({"schema_version":"truenav-registry-root-v3","root_sha256":root,"registry_account":snapshot.registry_account,"block_height":snapshot.block_height,"block_hash":snapshot.block_hash});
    report["policy"] = json!({"schema_version":"truenav-source-policy-v3","source_registry":policy.source_registry,"minimum_revisions":policy.minimum_revisions,"case_sensitive_namespaces":policy.case_sensitive_namespaces,"previous_cash_passport":policy.previous_cash_passport,"previous_period":policy.previous_period});
    report["score_x100"] = if scored {
        json!(nav::half_up(final_score * 100.0))
    } else {
        Value::Null
    };
    report["parts_x100"] = if scored {
        json!({"gap":nav::half_up(nav.gap*100.0),"coverage":nav::half_up(nav.coverage*100.0),"freshness":nav::half_up(nav.fresh*100.0),"penalty":nav::half_up(nav.penalty*100.0)})
    } else {
        Value::Null
    };
    report["raw_score"] = if scored {
        json!(truenav_v3_core::wire::decimal(nav.raw)?)
    } else {
        Value::Null
    };
    report["sources"] = inputs.clone();
    seal(e, report, &inputs, &nonce, salt)
}

/// A host uses this for every sibling in the sealed complete fund roster before R10.
/// It verifies the same signatures, terms and fixed-block registry ownership as the primary fund.
pub fn sibling_nav(
    c: &Context,
    sources: &[SignedSource],
    policy: &Policy,
    snapshot: &Snapshot,
    mac: &dyn Fingerprinter,
) -> Result<Value> {
    if !snapshot.finalized {
        return Err("registry_snapshot_invalid");
    }
    let mut docs = BTreeMap::new();
    for s in sources {
        verify_source(
            s,
            &policy.source_registry,
            &c.scope,
            &c.period,
            *policy
                .minimum_revisions
                .get(&s.source)
                .ok_or("revision_policy_missing")?,
        )?;
        if docs.insert(s.source.as_str(), &s.payload).is_some() {
            return Err("source_roles");
        }
    }
    if docs.len() != 4 {
        return Err("source_roles");
    }
    let mut fund = docs.get("fund_admin").ok_or("source_roles")?["fund"].clone();
    if fund["fund_id"] != c.scope.token_id {
        return Err("source_scope_mismatch");
    }
    let mut loans = docs.get("servicer").ok_or("source_roles")?["loans"]
        .as_array()
        .ok_or("loan_tape_invalid")?
        .clone();
    let terms = docs.get("custodian").ok_or("source_roles")?["loan_terms"]
        .as_array()
        .ok_or("loan_terms_missing")?;
    if loans.len() > 10000 || terms.len() != loans.len() {
        return Err("loan_terms_missing");
    }
    let mut seen = BTreeSet::new();
    for loan in &mut loans {
        let found: Vec<_> = terms
            .iter()
            .filter(|r| r["loan_id"] == loan["id"])
            .collect();
        if found.len() != 1 {
            return Err("loan_terms_missing");
        }
        let row = found[0];
        let terms: LoanTerms =
            serde_json::from_value(row["terms"].clone()).map_err(|_| "loan_terms_invalid")?;
        if canonical_terms(&terms, &policy.case_sensitive_namespaces)? != row["terms"]
            || row["terms"] != loan["terms"]
            || row["lien_rank"] != loan["lien_rank"]
        {
            return Err("loan_terms_scope_mismatch");
        }
        let asset = loan["asset"].as_str().ok_or("loan_terms_invalid")?;
        let fp = fingerprint(&terms, asset, &policy.case_sensitive_namespaces, mac)?;
        let rank = row["lien_rank"]
            .as_u64()
            .filter(|r| *r > 0)
            .ok_or("loan_terms_invalid")?;
        let read = snapshot.locks.iter().find(|r| r.fingerprint == fp);
        let own = read.is_some_and(|r| {
            r.completed
                && r.owner.as_deref() == Some(&c.scope.fund_account)
                && r.fund_token_id.as_deref() == Some(&c.scope.token_id)
        });
        let duplicate = !seen.insert(fp.clone());
        loan["nft"] = json!(own && rank == 1 && !duplicate);
        loan["nft_id"] = json!(fp);
        loan["anomaly"] = json!(loan["anomaly"] == true || !own || rank >= 2 || duplicate);
    }
    fund["source_data_asof"] = json!(sources
        .iter()
        .map(|s| s.data_as_of.as_str())
        .min_by_key(|s| timestamp(s).unwrap_or(i64::MIN)));
    fund["registry_manager_id"] = json!(snapshot.manager_id);
    fund["loans"] = json!(loans);
    let now = timestamp(&c.valuation_time)?;
    let mut seen = BTreeSet::new();
    let mut attempts = Vec::new();
    for event in snapshot
        .attempts
        .as_array()
        .ok_or("registry_attempts_invalid")?
    {
        let id = event["action_id"]
            .as_str()
            .ok_or("registry_attempts_invalid")?;
        let at = timestamp(event["at"].as_str().ok_or("registry_attempts_invalid")?)?;
        if at > now {
            return Err("registry_attempts_invalid");
        }
        if seen.insert(id) {
            attempts.push(json!({"action_id":id,"age_days":(now-at)as f64/86_400_000.0}))
        }
    }
    fund["blocked_attempts"] = json!(attempts);
    Ok(fund)
}

impl Output {
    /// The contract adds its issued_at, proof reference and receipt hash. Never print private_report.
    pub fn execution_body(&self) -> Value {
        let mut b = self.envelope.clone();
        for k in ["receipt_sha256", "attestation_ref", "issued_at"] {
            b.as_object_mut().expect("validated envelope").remove(k);
        }
        b
    }
}

#[cfg(test)]
mod cents_tests {
    use super::tape_principal_cents;
    use serde_json::json;

    #[test]
    fn tape_principal_cents_parses_decimal_text_not_a_float_multiply() {
        assert_eq!(tape_principal_cents(&json!(100000)).unwrap(), 10_000_000);
        assert_eq!(tape_principal_cents(&json!(200_000.0)).unwrap(), 20_000_000);
        assert_eq!(
            tape_principal_cents(&json!("100000.10")).unwrap(),
            10_000_010
        );
        assert_eq!(tape_principal_cents(&json!("1.005")).unwrap(), 101);
        assert!(tape_principal_cents(&json!("90071992547409.92")).is_none());
        assert_eq!(
            tape_principal_cents(&json!("90071992547409.91")).unwrap(),
            9_007_199_254_740_991
        );
    }
}
