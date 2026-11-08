//! Metrics (cashflow/metrics.mjs) and score (spec/v2/score.mjs), ported line for line.
use crate::base::*;
use crate::matcher::Matched;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

pub const METHOD: &str = "cashflow-v2.0.0";
pub const MIN_COHORT: i64 = 5;
pub const COHORTS: [(&str, i64, i64); 4] = [("current", 0, 29), ("30", 30, 59), ("60", 60, 89), ("90+", 90, i64::MAX)];
fn cohort_of(dpd: i64) -> &'static str {
    COHORTS.iter().find(|(_, lo, hi)| dpd >= *lo && dpd <= *hi).map(|c| c.0).unwrap_or("current")
}
fn ratio_bps(a: i64, b: i64, if_zero: i64) -> R<i64> {
    if b == 0 {
        Ok(if_zero)
    } else {
        rhu(10000 * a, b)
    }
}

pub fn metrics(kind: &str, m: &Matched, issuer: &Value, units: &[(String, i64)], as_of: &str, period: &str, days_in_period: i64) -> R<Value> {
    let now = days(as_of)?;
    let settled_capped = |settled: i64, due: i64| settled.min(due);
    let in_period: Vec<_> = m.due.iter().filter(|d| d.period == period).collect();
    let cash_received: i64 = in_period.iter().map(|d| settled_capped(d.settled, d.amount_due)).sum();
    let period_claims: Vec<_> = m.claims.iter().filter(|c| c.linked_due.is_some() && c.paid_date.chars().take(7).collect::<String>() == period && c.outcome.as_deref() != Some("reversed_by_manager")).collect();
    let claimed_cash: i64 = period_claims.iter().map(|c| c.amount).sum();
    let settled_claims: i64 = period_claims.iter().filter(|c| c.settled_by.is_some()).map(|c| c.amount).sum();
    let cns: i64 = period_claims.iter().filter(|c| c.outcome.as_deref() == Some("claimed_not_settled")).map(|c| c.amount).sum();
    let cash_match = ratio_bps(settled_claims, claimed_cash, 10000)?.min(10000);

    let mut per_unit: HashMap<String, (i64, i64)> = HashMap::new();
    for d in &m.due {
        if d.status == "paid_full" || days(&d.due_date)? > now {
            continue;
        }
        let dpd = now - days(&d.due_date)?;
        let u = per_unit.entry(d.unit_ref.clone()).or_insert((-1, 0));
        u.0 = u.0.max(dpd);
        u.1 += d.amount_due - settled_capped(d.settled, d.amount_due);
    }
    let unit_map: HashMap<&str, i64> = units.iter().map(|(k, v)| (k.as_str(), *v)).collect();
    let mut all_units: Vec<String> = vec![];
    let mut seen = HashSet::new();
    for u in m.due.iter().map(|d| d.unit_ref.clone()).chain(units.iter().map(|(k, _)| k.clone())) {
        if seen.insert(u.clone()) {
            all_units.push(u);
        }
    }
    let mut cohorts: Vec<(&str, i64, i64)> = COHORTS.iter().map(|c| (c.0, 0, 0)).collect();
    for u in &all_units {
        let p = per_unit.get(u);
        let c = p.map(|p| cohort_of(p.0)).unwrap_or("current");
        let outstanding = if kind == "credit" { unit_map.get(u.as_str()).copied().unwrap_or(0) } else { p.map(|p| p.1).unwrap_or(0) };
        let e = cohorts.iter_mut().find(|e| e.0 == c).unwrap();
        e.1 += 1;
        e.2 += outstanding;
    }
    let get = |k: &str| cohorts.iter().find(|e| e.0 == k).unwrap().2;
    let late60 = get("60") + get("90+");

    let mut flags: Vec<Value> = vec![];
    let mut cohorts_json = Map::new();
    for (k, n, o) in &cohorts {
        cohorts_json.insert((*k).into(), json!({ "units": n, "outstanding_cents": o }));
    }
    let mut ex = Map::new();
    for (k, v) in &m.exceptions {
        ex.insert((*k).into(), json!(v));
    }
    ex.insert("claimed_not_settled_cents".into(), json!(cns));
    let mut out = json!({ "kind": kind, "period": period, "as_of": as_of, "cash_received_cents": cash_received, "claimed_cash_cents": claimed_cash, "cash_match_bps": cash_match, "cohorts": cohorts_json });

    if kind == "credit" {
        let cash_interest: i64 = in_period.iter().filter(|d| d.component == "interest").map(|d| settled_capped(d.settled, d.amount_due)).sum();
        let principal = int(issuer, "principal_outstanding_cents")?;
        let cash_yield = if principal > 0 { rhu(cash_interest * 365 * 10000, days_in_period * principal)? } else { 0 };
        let total_principal: i64 = all_units.iter().map(|u| unit_map.get(u.as_str()).copied().unwrap_or(0)).sum();
        let reported = int(issuer, "reported_yield_bps")?;
        let o = out.as_object_mut().unwrap();
        o.insert("cash_interest_cents".into(), json!(cash_interest));
        o.insert("accrued_interest_cents".into(), json!(int_or0(issuer, "accrued_interest_cents")?));
        o.insert("capitalized_interest_cents".into(), json!(int_or0(issuer, "capitalized_interest_cents")?));
        o.insert("reported_yield_bps".into(), json!(reported));
        o.insert("cash_yield_bps".into(), json!(cash_yield));
        o.insert("yield_gap_bps".into(), json!((reported - cash_yield).max(0)));
        o.insert("late_share_bps".into(), json!(ratio_bps(late60, total_principal, 0)?));
    } else {
        let rent_due: i64 = in_period.iter().filter(|d| d.component == "rent").map(|d| d.amount_due).sum();
        let rent_collected: i64 = in_period.iter().filter(|d| d.component == "rent").map(|d| settled_capped(d.settled, d.amount_due)).sum();
        let row_outcome = |t: &crate::matcher::Txn| t.outcome.clone().unwrap_or_else(|| if t.amount < 0 { t.kind_hint.clone() } else { "unattributed".into() });
        let debits_of = |k: &str| -> Vec<&crate::matcher::Txn> { m.bank.iter().filter(|t| t.posted_date.chars().take(7).collect::<String>() == period && t.amount < 0 && t.kind_hint == k && row_outcome(t) == k).collect() };
        let mut distributions = -debits_of("distribution").iter().map(|t| t.amount).sum::<i64>();
        if distributions == 0 && int_or0(issuer, "distributions_paid_cents")? > 0 {
            distributions = int_or0(issuer, "distributions_paid_cents")?;
            flags.push(json!("distributions_self_reported"));
        }
        ex.insert("distribution_funded_by_sponsor".into(), json!(debits_of("distribution").iter().filter(|t| t.funded_by_sponsor == Some(true)).count() as i64));
        let mut expenses = -debits_of("expense").iter().map(|t| t.amount).sum::<i64>();
        if expenses == 0 && int_or0(issuer, "expenses_cents")? > 0 {
            expenses = int_or0(issuer, "expenses_cents")?;
            flags.push(json!("expenses_self_reported"));
        }
        let reserves = int_or0(issuer, "reserves_cents")?;
        let noc = rent_collected - expenses - reserves;
        let coverage = if distributions == 0 { 10000 } else if noc <= 0 { 0 } else { rhu(10000 * noc, distributions)? };
        let o = out.as_object_mut().unwrap();
        o.insert("rent_due_cents".into(), json!(rent_due));
        o.insert("rent_collected_cents".into(), json!(rent_collected));
        o.insert("collection_rate_bps".into(), json!(ratio_bps(rent_collected, rent_due, 10000)?));
        o.insert("occupancy_bps".into(), issuer.get("occupancy_bps").cloned().ok_or("occupancy_bps missing")?);
        o.insert("expenses_cents".into(), json!(expenses));
        o.insert("reserves_cents".into(), json!(reserves));
        o.insert("net_operating_cash_cents".into(), json!(noc));
        o.insert("distributions_cents".into(), json!(distributions));
        o.insert("rental_coverage_bps".into(), json!(coverage));
        o.insert("late_share_bps".into(), json!(ratio_bps(late60, rent_due, 0)?));
    }
    let o = out.as_object_mut().unwrap();
    o.insert("exceptions".into(), Value::Object(ex));
    o.insert("flags".into(), Value::Array(flags));
    Ok(out)
}

pub fn public_metrics(mt: &Value) -> Value {
    let mut p = mt.clone();
    if let Some(c) = p.get_mut("cohorts").and_then(Value::as_object_mut) {
        for (_, v) in c.iter_mut() {
            let n = v.get("units").and_then(Value::as_i64).unwrap_or(0);
            if n > 0 && n < MIN_COHORT {
                *v = json!({ "suppressed": "fewer than 5" });
            }
        }
    }
    p
}

// ---- score (spec/v2/score.mjs) -------------------------------------------------------------------------------

pub const CAPS: [(&str, &str); 5] = [
    ("self_reported_only", "red because no fresh bank-sourced evidence was available: self-reported only"),
    ("yield_gap", "red because the reported yield is at least 3.00 percentage points above the cash yield"),
    ("payout_exceeds_net_cash", "red because payouts exceed net cash from rent"),
    ("distribution_funded_by_sponsor", "red because part of a payout was funded by a sponsor transfer, not by income"),
    ("claimed_not_settled", "red because more than 2% of the cash the manager reports was never settled by the bank"),
];
fn window(cadence: &str) -> R<(i64, i64)> {
    match cadence {
        "daily" => Ok((24, 168)),
        "monthly" => Ok((35 * 24, 65 * 24)),
        c => Err(format!("unknown cadence {c}")),
    }
}
pub struct ScoreSource {
    pub tier: i64,
    pub cadence: String,
    pub age_hours: i64,
    pub carried_forward: bool,
}
pub fn source_freshness_bps(s: &ScoreSource) -> R<i64> {
    if s.carried_forward {
        return Ok(0);
    }
    let (full, zero) = window(&s.cadence)?;
    if s.age_hours < 0 {
        return Err("age_hours must be a non-negative integer".into());
    }
    if s.age_hours <= full {
        return Ok(10000);
    }
    if s.age_hours >= zero {
        return Ok(0);
    }
    rhu(10000 * (zero - s.age_hours), zero - full)
}
fn is_fresh(s: &ScoreSource) -> R<bool> {
    if s.carried_forward {
        return Ok(false);
    }
    let (full, _) = window(&s.cadence)?;
    Ok(s.age_hours >= 0 && s.age_hours <= full)
}

pub fn score(mt: &Value, sources: &[ScoreSource]) -> R<Value> {
    let kind = mt.get("kind").and_then(Value::as_str).unwrap_or("");
    if kind != "credit" && kind != "rental" {
        return Err("kind must be credit or rental".into());
    }
    let mut fresh = vec![];
    for s in sources {
        fresh.push(source_freshness_bps(s)?);
    }
    let run_fresh = fresh.iter().copied().min().unwrap_or(0);
    let cash_match = int(mt, "cash_match_bps")?.clamp(0, 10000);
    let late = int(mt, "late_share_bps")?.clamp(0, 2000);
    let gap = if kind == "credit" { rhu(2500 * (500 - int(mt, "yield_gap_bps")?.clamp(0, 500)), 500)? } else { rhu(2500 * (int(mt, "rental_coverage_bps")? - 8000).clamp(0, 2000), 2000)? };
    let parts = (rhu(4000 * cash_match, 10000)?, gap, rhu(1500 * (2000 - late), 2000)?, rhu(2000 * run_fresh, 10000)?);
    let raw = parts.0 + parts.1 + parts.2 + parts.3;
    let uncapped = rhu(raw, 100)?;
    let ex = mt.get("exceptions").ok_or("exceptions missing")?;
    let mut caps = vec![];
    let mut fresh_tier3 = false;
    for s in sources {
        if s.tier == 3 && is_fresh(s)? {
            fresh_tier3 = true;
        }
    }
    if !fresh_tier3 {
        caps.push("self_reported_only");
    }
    if kind == "credit" && int(mt, "yield_gap_bps")? >= 300 {
        caps.push("yield_gap");
    }
    if kind == "rental" && int(mt, "rental_coverage_bps")? < 10000 {
        caps.push("payout_exceeds_net_cash");
    }
    if int_or0(ex, "distribution_funded_by_sponsor")? > 0 {
        caps.push("distribution_funded_by_sponsor");
    }
    let claimed = int(mt, "claimed_cash_cents")?;
    if claimed > 0 && int_or0(ex, "claimed_not_settled_cents")? * 10000 > 200 * claimed {
        caps.push("claimed_not_settled");
    }
    let value = if caps.is_empty() { uncapped } else { uncapped.min(59) };
    let band = if value >= 85 { "green" } else if value >= 60 { "yellow" } else { "red" };
    let caps_json: Vec<Value> = caps.iter().map(|c| json!({ "code": c, "reason": CAPS.iter().find(|x| x.0 == *c).unwrap().1 })).collect();
    Ok(json!({ "method": METHOD, "parts_x100": { "cash_match": parts.0, "gap": parts.1, "late": parts.2, "freshness": parts.3 }, "raw_x100": raw, "uncapped_score": uncapped, "score": value, "band": band, "caps": caps_json, "run_freshness_bps": run_fresh }))
}
