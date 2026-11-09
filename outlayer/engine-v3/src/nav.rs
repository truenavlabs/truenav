//! R1-R24 NAV calculation. Inputs to this module have passed signed-source/registry checks.
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use truenav_v3_core::timestamp;

fn num(v: &Value) -> Option<f64> {
    v.as_f64().filter(|x| x.is_finite())
}
fn n(v: &Value, k: &str) -> Option<f64> {
    num(&v[k])
}
fn id(v: &Value) -> Option<String> {
    v.as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| num(v).map(|n| n.to_string()))
}
fn age(s: &Value, now: i64) -> Option<f64> {
    s.as_str()
        .and_then(|s| timestamp(s).ok())
        .map(|x| ((now - x) as f64 / 3_600_000.0).max(0.0))
}
pub fn freshness(h: f64) -> f64 {
    if h <= 24.0 {
        1.0
    } else {
        (1.0 - (h - 24.0) / 144.0).max(0.0)
    }
}
pub fn attempt_cost(days: f64) -> f64 {
    15.0 * 0.5f64.powf(days.max(0.0) / 30.0)
}
pub fn half_up(x: f64) -> u64 {
    (x.max(0.0) + 0.5).floor() as u64
}
#[derive(Clone, Debug)]
pub struct Line {
    pub id: String,
    pub open: bool,
    pub verified: bool,
    pub ead: f64,
    pub mark: f64,
    pub v50: f64,
    pub pd: f64,
    pub lgd: f64,
    pub unknown: bool,
    pub bucket: String,
    pub obligor: String,
}
#[derive(Clone, Debug)]
pub struct Attempt {
    pub id: String,
    pub has_id: bool,
    pub age: f64,
    pub cost: f64,
}
#[derive(Clone, Debug)]
pub struct Nav {
    pub fund_id: String,
    pub manager: Option<String>,
    pub status: String,
    pub headline: f64,
    pub policy: f64,
    pub listed: f64,
    pub lih: f64,
    pub trueval: f64,
    pub low: f64,
    pub high: f64,
    pub variance: f64,
    pub gap: f64,
    pub coverage: f64,
    pub fresh: f64,
    pub penalty: f64,
    pub raw: f64,
    pub data_as_of: Option<String>,
    pub unverified_share: Option<f64>,
    pub unknown_exposure: bool,
    pub over: f64,
    pub under: f64,
    pub recent: bool,
    pub concentration_largest: bool,
    pub concentration_five: bool,
    pub lines: Vec<Line>,
    pub attempts: Vec<Attempt>,
    pub at_ms: i64,
}
fn attempts(v: &Value) -> Vec<Attempt> {
    let mut out: Vec<Attempt> = Vec::new();
    let mut ids = BTreeMap::new();
    for (i, a) in v.as_array().into_iter().flatten().enumerate() {
        let aid = id(&a["action_id"]);
        let d = n(a, "age_days").unwrap_or(0.0).max(0.0);
        if let Some(key) = &aid {
            if let Some(&k) = ids.get(key) {
                let row: &mut Attempt = &mut out[k];
                if d < row.age {
                    row.age = d;
                    row.cost = attempt_cost(d)
                }
                continue;
            }
            ids.insert(key.clone(), out.len());
        }
        out.push(Attempt {
            id: aid.clone().unwrap_or_else(|| format!("#{i}")),
            has_id: aid.is_some(),
            age: d,
            cost: attempt_cost(d),
        });
    }
    out
}
pub fn score(fund: &Value, now: i64, history: &Value) -> Nav {
    let mut invalid = false;
    let mut lines = Vec::new();
    let mut seen = BTreeSet::new();
    let cash_input = n(fund, "cash").unwrap_or(0.0);
    if fund.get("cash").is_some() && n(fund, "cash").is_none() {
        invalid = true
    }
    let mut liab = n(fund, "liabilities").unwrap_or(0.0);
    if fund.get("liabilities").is_some() && (n(fund, "liabilities").is_none() || liab < 0.0) {
        invalid = true
    }
    liab += (-cash_input).max(0.0);
    let cash = cash_input.max(0.0);
    let cash_age = age(&fund["cash_asof"], now);
    let cash_future = fund["cash_asof"]
        .as_str()
        .and_then(|s| timestamp(s).ok())
        .is_some_and(|t| t - now > 600000);
    let cash_claimed = fund["cash_attested"] == true;
    let cash_attested = cash_claimed && !cash_future && cash_age.is_some_and(|h| h <= 168.0);
    for (i, l) in fund["loans"].as_array().into_iter().flatten().enumerate() {
        let loan_id = id(&l["id"]).unwrap_or_else(|| format!("#{i}"));
        let principal = n(l, "principal");
        let accrued = n(l, "accrued");
        let repaid = n(l, "repaid");
        let known = principal.is_some() && accrued.is_some() && repaid.is_some();
        let ead = principal.unwrap_or(0.0) + accrued.unwrap_or(0.0) - repaid.unwrap_or(0.0);
        let unknown = principal.is_none() || accrued.is_none();
        let bucket = l["bucket"].as_str().unwrap_or("");
        if known && ead == 0.0 {
            lines.push(Line {
                id: loan_id,
                open: false,
                verified: false,
                ead: 0.0,
                mark: 0.0,
                v50: 0.0,
                pd: 0.0,
                lgd: 0.0,
                unknown: false,
                bucket: bucket.into(),
                obligor: format!("loan-index:{i}"),
            });
            continue;
        }
        let pd = match bucket {
            "current" => Some(0.02),
            "dpd_1_30" => Some(0.1),
            "dpd_31_60" => Some(0.25),
            "dpd_61_90" => Some(0.45),
            "dpd_over_90" => Some(1.0),
            _ => None,
        };
        let lgd = match l["asset"].as_str() {
            Some("real_estate") => Some(0.31),
            Some("invoices") => Some(0.67),
            _ => None,
        };
        let dpd_ok = match l.get("dpd") {
            None | Some(Value::Null) => true,
            Some(x) => num(x).is_some_and(|d| match bucket {
                "current" => d <= 0.0,
                "dpd_1_30" => (1.0..=30.0).contains(&d),
                "dpd_31_60" => (31.0..=60.0).contains(&d),
                "dpd_61_90" => (61.0..=90.0).contains(&d),
                "dpd_over_90" => d >= 91.0,
                _ => false,
            }),
        };
        let mut excluded = !known || pd.is_none() || lgd.is_none() || !dpd_ok || ead < 0.0;
        let mark_raw = if l.get("reported_value").is_some() {
            match n(l, "reported_value") {
                Some(v) => v,
                None => {
                    excluded = true;
                    0.0
                }
            }
        } else {
            let md = fund["policy_markdown"]
                .get(bucket)
                .and_then(num)
                .unwrap_or(0.0);
            if !(0.0..=1.0).contains(&md)
                || fund["policy_markdown"]
                    .get(bucket)
                    .is_some_and(|x| num(x).is_none())
            {
                excluded = true;
                0.0
            } else {
                ead * (1.0 - md)
            }
        };
        let nft = l["nft"] == true;
        let nft_id = id(&l["nft_id"]);
        if nft {
            if let Some(key) = nft_id {
                if !seen.insert(key) {
                    excluded = true
                }
            } else {
                excluded = true
            }
        }
        let verified = !excluded && nft && l["anomaly"] != true;
        let mark = mark_raw.max(0.0);
        let v50 = mark.max(if unknown { 0.0 } else { ead.max(0.0) });
        lines.push(Line {
            id: loan_id,
            open: true,
            verified,
            ead: ead.max(0.0),
            mark,
            v50,
            pd: pd.unwrap_or(0.0),
            lgd: lgd.unwrap_or(0.0),
            unknown,
            bucket: bucket.into(),
            obligor: id(&l["obligor_id"])
                .map(|id| format!("obligor:{id}"))
                .unwrap_or_else(|| format!("loan-index:{i}")),
        });
    }
    let open: Vec<_> = lines.iter().filter(|l| l.open).collect();
    let verified: Vec<_> = open.iter().filter(|l| l.verified).collect();
    let listed: f64 = open.iter().map(|l| l.mark).sum();
    let headline = n(fund, "headline_nav").unwrap_or(listed);
    let lih = headline + liab - if cash_attested { cash } else { 0.0 };
    let policy: f64 = verified.iter().map(|l| l.mark).sum();
    let trueval: f64 = verified.iter().map(|l| l.ead * (1.0 - l.pd * l.lgd)).sum();
    let variance: f64 = verified
        .iter()
        .map(|l| l.ead.powi(2) * l.lgd.powi(2) * l.pd * (1.0 - l.pd))
        .sum();
    let radius = 1.96 * variance.sqrt();
    let low = trueval - radius;
    let high = trueval + radius;
    let over = (lih - high).max(0.0);
    let under = (low - lih.min(policy)).max(0.0);
    let beyond = over.max(under);
    let gap = if verified.is_empty() {
        0.0
    } else if beyond == 0.0 {
        40.0
    } else if trueval > 0.0 {
        40.0 * (1.0 - beyond / (0.1 * trueval)).max(0.0)
    } else {
        0.0
    };
    let coverage = if lih.max(listed) > 0.0 {
        40.0 * (policy / lih.max(listed)).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let mut times = Vec::new();
    let mut missing = false;
    for l in fund["loans"].as_array().into_iter().flatten() {
        match l["servicer_asof"].as_str().and_then(|s| timestamp(s).ok()) {
            Some(t) => times.push((t, l["servicer_asof"].as_str().unwrap().to_string())),
            None => missing = true,
        }
    }
    for t in [&fund["nav_report_date"], &fund["certificate"]["data_asof"]]
        .into_iter()
        .chain(if cash_attested {
            Some(&fund["cash_asof"])
        } else {
            None
        })
    {
        match t.as_str().and_then(|s| timestamp(s).ok()) {
            Some(ms) => times.push((ms, t.as_str().unwrap().into())),
            None => missing = true,
        }
    }
    if let Some(source) = fund.get("source_data_asof") {
        match source.as_str().and_then(|s| timestamp(s).ok()) {
            Some(t) => times.push((t, source.as_str().unwrap().into())),
            None => missing = true,
        }
    }
    let oldest = times.iter().min_by_key(|(t, _)| *t);
    let data_age = if missing {
        None
    } else {
        oldest.map(|(t, _)| ((now - *t) as f64 / 3_600_000.0).max(0.0))
    };
    let fresh = if cash_claimed && cash_age.is_some_and(|a| a > 168.0) {
        0.0
    } else {
        20.0 * data_age.map(freshness).unwrap_or(0.0)
    };
    let atts = attempts(&fund["blocked_attempts"]);
    let penalty: f64 = atts.iter().map(|a| a.cost).sum();
    let recent = atts.iter().any(|a| a.age <= 30.0);
    let not_listed = (headline - (listed + cash - liab)).max(0.0);
    let uv: f64 = open
        .iter()
        .filter(|l| !l.verified)
        .map(|l| l.v50)
        .sum::<f64>()
        + not_listed
        + if cash_attested { 0.0 } else { cash };
    let d50 = headline.max(
        open.iter()
            .map(|l| {
                if l.verified {
                    l.mark.min(l.ead)
                } else {
                    l.mark
                }
            })
            .sum(),
    );
    let uvshare = if d50 > 0.0 {
        Some(uv / d50)
    } else if uv > 0.0 {
        None
    } else {
        Some(0.0)
    };
    let overhalf = if d50 > 0.0 {
        2.0 * (uv * 100.0).round() > (d50 * 100.0).round()
    } else {
        uv > 0.0
    };
    let unknown_exposure = open.iter().any(|l| !l.verified && l.unknown);
    let cert = fund["certificate"].as_object();
    let previous = history.as_array().into_iter().flatten().any(|h| {
        h["fund_id"] == fund["fund_id"]
            && h["signed_at"]
                .as_str()
                .and_then(|t| timestamp(t).ok())
                .is_some_and(|t| t < now)
    });
    let stale = data_age.is_none_or(|h| h > 720.0);
    let raw = gap + coverage + fresh - penalty;
    if [trueval, radius, listed, policy, lih, raw]
        .iter()
        .any(|x| !x.is_finite())
    {
        invalid = true
    }
    let status = if invalid {
        "invalid_fund_fields"
    } else if (previous && (cert.is_none() || n(fund, "headline_nav").is_none() || stale))
        || (cert.is_some() && stale)
    {
        "verification_failed"
    } else if !previous && (cert.is_none() || n(fund, "headline_nav").is_none()) {
        "not_rated"
    } else if open.is_empty() {
        if headline > 0.0 {
            "disclaimed"
        } else {
            "not_rated"
        }
    } else if unknown_exposure || overhalf {
        "disclaimed"
    } else {
        "scored"
    };
    let mut groups: BTreeMap<&str, f64> = BTreeMap::new();
    for l in &open {
        *groups.entry(&l.obligor).or_default() += if l.unknown { l.v50 } else { l.ead }
    }
    let total: f64 = groups.values().sum();
    let mut amounts: Vec<_> = groups.values().copied().collect();
    amounts.sort_by(|a, b| b.total_cmp(a));
    let manager =
        id(&fund["certificate"]["manager_id"]).or_else(|| id(&fund["certificate"]["signer"]));
    Nav {
        fund_id: fund["fund_id"].as_str().unwrap_or("").into(),
        manager,
        status: status.into(),
        headline,
        policy,
        listed,
        lih,
        trueval,
        low,
        high,
        variance,
        gap,
        coverage,
        fresh,
        penalty,
        raw,
        data_as_of: if missing {
            None
        } else {
            oldest.map(|(_, s)| s.clone())
        },
        unverified_share: uvshare,
        unknown_exposure,
        over,
        under,
        recent,
        concentration_largest: total > 0.0
            && amounts.first().copied().unwrap_or(0.0) / total > 0.15,
        concentration_five: total > 0.0 && amounts.iter().take(5).sum::<f64>() / total > 0.5,
        lines,
        attempts: atts,
        at_ms: now,
    }
}
impl Nav {
    pub fn private_json(&self) -> Value {
        json!({"status":self.status,"reported_nav":self.headline,"trueval":self.trueval,"truerange_low":self.low,"truerange_high":self.high,"policy_nav":self.policy,"parts":{"gap":self.gap,"coverage":self.coverage,"freshness":self.fresh,"penalty":self.penalty},"raw":self.raw,"unverified_share":self.unverified_share,"data_as_of":self.data_as_of})
    }
}

/// R10 two-pass manager escalation. The complete manager roster and event records are authenticated inputs.
pub fn portfolio(funds: &[Value], now: i64, histories: &Value, attempt_log: &Value) -> Vec<Nav> {
    let mut results: Vec<_> = funds
        .iter()
        .map(|f| score(f, now, &histories[f["fund_id"].as_str().unwrap_or("")]))
        .collect();
    let mut managers: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (i, r) in results.iter_mut().enumerate() {
        if r.manager.is_none() {
            let mut ms = BTreeSet::new();
            if let Some(log) = attempt_log[&r.fund_id].as_object() {
                for row in log.values() {
                    if let Some(m) = id(&row["manager_id"]) {
                        ms.insert(m);
                    }
                }
            }
            if ms.len() == 1 {
                r.manager = ms.into_iter().next();
            }
        }
        if let Some(m) = &r.manager {
            managers.entry(m.clone()).or_default().push(i);
        }
    }
    #[derive(Clone)]
    struct Group {
        id: String,
        age: f64,
        listers: Vec<usize>,
        cost: f64,
    }
    for (_manager, idxs) in managers {
        let mut groups: BTreeMap<String, Group> = BTreeMap::new();
        for &i in &idxs {
            for a in &results[i].attempts {
                let key = if a.has_id {
                    a.id.clone()
                } else {
                    format!("{i}:{}", a.id)
                };
                let g = groups.entry(key).or_insert(Group {
                    id: a.id.clone(),
                    age: a.age,
                    listers: vec![],
                    cost: a.cost,
                });
                g.age = g.age.min(a.age);
                g.cost = attempt_cost(g.age);
                if !g.listers.contains(&i) {
                    g.listers.push(i)
                }
            }
        }
        let groups: Vec<_> = groups.into_values().collect();
        let largest = idxs.iter().map(|&i| results[i].policy).fold(0.0, f64::max);
        for &i in &idxs {
            results[i].penalty = groups
                .iter()
                .filter(|g| g.listers.contains(&i))
                .map(|g| g.cost)
                .sum();
            results[i].raw =
                results[i].gap + results[i].coverage + results[i].fresh - results[i].penalty;
        }
        let floor_bind = idxs.iter().any(|&i| {
            results[i].status == "scored" && results[i].penalty > 0.0 && results[i].raw <= 0.0
        });
        for g in &groups {
            let shell = g.listers.iter().any(|&i| {
                let r = &results[i];
                let rec = &attempt_log[&r.fund_id][&g.id];
                let status = rec["attempting_status"].as_str().unwrap_or(&r.status);
                let pn = n(rec, "attempting_policy_nav").unwrap_or(r.policy);
                let lg = n(rec, "largest_policy_nav").unwrap_or(largest);
                let open = n(rec, "attempting_open_loans")
                    .unwrap_or(r.lines.iter().filter(|l| l.open).count() as f64);
                open == 0.0 || status != "scored" || (lg > 0.0 && pn < 0.1 * lg)
            });
            let second = groups.iter().any(|b| {
                (b.age > g.age || (b.age == g.age && b.id < g.id)) && b.age - g.age <= 90.0
            });
            if shell || second || floor_bind {
                for &i in &idxs {
                    if !g.listers.contains(&i) {
                        results[i].penalty += g.cost;
                        if g.age <= 30.0 {
                            results[i].recent = true
                        }
                    }
                }
            }
        }
    }
    for r in &mut results {
        r.raw = r.gap + r.coverage + r.fresh - r.penalty;
    }
    results
}
