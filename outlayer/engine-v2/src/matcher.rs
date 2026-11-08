//! Adapters (cashflow/adapters/*.mjs) and the three-way match (cashflow/match.mjs, rules M1 to M6), ported line for
//! line: same iteration order, same first-match rules, same outputs.
use crate::base::*;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

pub const SETTLE_BEFORE: i64 = 2;
pub const SETTLE_AFTER: i64 = 5;
pub const REVERSAL_WINDOW_DAYS: i64 = 30;
pub const SPONSOR_WINDOW_DAYS: i64 = 10;
pub const EXCEPTIONS: [&str; 9] = [
    "claimed_not_settled", "settled_not_claimed", "duplicate_claim", "duplicate_bank_txn", "probable_reversal",
    "batch_mismatch", "claim_without_due", "unapplied_credit", "distribution_funded_by_sponsor",
];
fn not_income(kind: &str) -> bool {
    matches!(kind, "security_deposit" | "owner_transfer" | "loan_proceeds" | "refund")
}

#[derive(Clone, Debug)]
pub struct Due {
    pub due_id: String,
    pub unit_ref: String,
    pub component: String,
    pub due_date: String,
    pub amount_due: i64,
    pub period: String,
    claimed: i64,
    pub settled: i64,
    pub status: &'static str,
}
#[derive(Clone, Debug)]
pub struct Claim {
    pub claim_id: String,
    due_id: Option<String>,
    pub unit_ref: String,
    pub paid_date: String,
    pub amount: i64,
    status: String,
    batch_ref: Option<String>,
    pub linked_due: Option<String>,
    pub settled_by: Option<String>,
    pub outcome: Option<String>,
}
#[derive(Clone, Debug)]
pub struct Txn {
    pub txn_id: String,
    pub posted_date: String,
    pub amount: i64,
    counterparty_ref: String,
    pub kind_hint: String,
    reversal_of: Option<String>,
    reversed: bool,
    pub used: i64,
    pub outcome: Option<String>,
    pub funded_by_sponsor: Option<bool>,
}

pub struct Source {
    pub due: Vec<Due>,
    pub claims: Vec<Claim>,
    pub payers: HashMap<String, String>,
    pub units: Vec<(String, i64)>,
}

// ---- adapters --------------------------------------------------------------------------------------------------

/// cashflow/adapters/bank.mjs settledFromFeed
pub fn settled_from_feed(feed: &Value, p: &dyn Pseudonymizer) -> R<Vec<Txn>> {
    let txs = feed.get("transactions").and_then(Value::as_array).ok_or("feed has no transactions array")?;
    let mut out = vec![];
    for t in txs {
        if truthy(t, "pending") {
            continue;
        }
        let amount = t.get("amount_cents").and_then(Value::as_i64).filter(|x| x.abs() <= MAX_SAFE).ok_or_else(|| format!("transaction {}: amount_cents must be integer", t.get("transaction_id").unwrap_or(&Value::Null)))?;
        let kind = match t.get("category").and_then(Value::as_str).unwrap_or("") {
            "RENT" => "rent",
            "LOAN_PAYMENT" => "loan_payment",
            "SECURITY_DEPOSIT" => "security_deposit",
            "OWNER_TRANSFER" => "owner_transfer",
            "LOAN_PROCEEDS" => "loan_proceeds",
            "REFUND" => "refund",
            "EXPENSE" => "expense",
            "DISTRIBUTION" => "distribution",
            _ => "unknown",
        };
        let cp = opt_s(t, "counterparty").unwrap_or_else(|| "UNKNOWN".into());
        out.push(Txn {
            txn_id: s(t, "transaction_id")?,
            posted_date: s(t, "date")?,
            amount: -amount,
            counterparty_ref: p.payer_ref(&cp)?,
            kind_hint: kind.into(),
            reversal_of: opt_s(t, "reversal_of"),
            reversed: false,
            used: 0,
            outcome: None,
            funded_by_sponsor: None,
        });
    }
    Ok(out)
}

fn claims_from(rows: &[Value], id_key: &str, unit_key: &str, p: &dyn Pseudonymizer) -> R<Vec<Claim>> {
    rows.iter()
        .map(|r| {
            Ok(Claim {
                claim_id: s(r, id_key)?,
                due_id: None,
                unit_ref: p.unit_ref(&s(r, unit_key)?)?,
                paid_date: s(r, "paid_date")?,
                amount: int(r, "amount_cents")?,
                status: opt_s(r, "status").unwrap_or_else(|| "paid".into()),
                batch_ref: opt_s(r, "batch_ref"),
                linked_due: None,
                settled_by: None,
                outcome: None,
            })
        })
        .collect()
}
fn due_row(id: String, unit_ref: String, component: String, due_date: String, amount: i64) -> Due {
    let period = due_date.chars().take(7).collect();
    Due { due_id: id, unit_ref, component, due_date, amount_due: amount, period, claimed: 0, settled: 0, status: "unpaid" }
}

/// cashflow/adapters/credit.mjs fromServicerTape
pub fn from_servicer_tape(tape: &Value, p: &dyn Pseudonymizer) -> R<Source> {
    let mut due = vec![];
    for (i, row) in arr(tape, "schedule")?.iter().enumerate() {
        due.push(due_row(format!("due-{i}"), p.unit_ref(&s(row, "loan_id")?)?, s(row, "component")?, s(row, "due_date")?, int(row, "amount_cents")?));
    }
    let claims = claims_from(arr(tape, "payments")?, "payment_id", "loan_id", p)?;
    let mut payers = HashMap::new();
    let mut units = vec![];
    for l in arr(tape, "loans")? {
        let u = p.unit_ref(&s(l, "loan_id")?)?;
        payers.insert(p.payer_ref(&s(l, "borrower_payer")?)?, u.clone());
        units.retain(|(k, _): &(String, i64)| *k != u);
        units.push((u, int(l, "principal_cents")?));
    }
    Ok(Source { due, claims, payers, units })
}

/// cashflow/adapters/rental.mjs fromManagerExport
pub fn from_manager_export(exp: &Value, p: &dyn Pseudonymizer) -> R<Source> {
    let mut due = vec![];
    for (i, c) in arr(exp, "charges")?.iter().enumerate() {
        due.push(due_row(format!("rent-{i}"), p.unit_ref(&s(c, "unit_id")?)?, "rent".into(), s(c, "due_date")?, int(c, "amount_cents")?));
    }
    let claims = claims_from(arr(exp, "ledger")?, "entry_id", "unit_id", p)?;
    let mut payers = HashMap::new();
    for u in arr(exp, "units")? {
        if let Some(t) = opt_s(u, "tenant_payer") {
            payers.insert(p.payer_ref(&t)?, p.unit_ref(&s(u, "unit_id")?)?);
        }
    }
    Ok(Source { due, claims, payers, units: vec![] })
}

// ---- the match -------------------------------------------------------------------------------------------------

pub struct Matched {
    pub due: Vec<Due>,
    pub claims: Vec<Claim>,
    pub bank: Vec<Txn>,
    pub exceptions: Vec<(&'static str, i64)>,
    pub claimed_not_settled_cents: i64,
    pub unapplied_credit_cents: i64,
    pub claimed_cash_cents: i64,
}

fn by_date_then_id(da: &str, ia: &str, db: &str, ib: &str) -> R<std::cmp::Ordering> {
    Ok(days(da)?.cmp(&days(db)?).then_with(|| ia.encode_utf16().cmp(ib.encode_utf16())))
}
fn sort_by_date<T>(v: &mut [T], f: impl Fn(&T) -> (&str, &str)) -> R<()> {
    for x in v.iter() {
        days(f(x).0)?;
    }
    v.sort_by(|a, b| {
        let (da, ia) = f(a);
        let (db, ib) = f(b);
        by_date_then_id(da, ia, db, ib).unwrap()
    });
    Ok(())
}
fn bump(ex: &mut [(&'static str, i64)], k: &str) {
    for e in ex.iter_mut() {
        if e.0 == k {
            e.1 += 1;
        }
    }
}

pub fn three_way(src: Source, bank_in: Vec<Txn>) -> R<Matched> {
    let payers = src.payers;
    let mut ex: Vec<(&'static str, i64)> = EXCEPTIONS.iter().map(|e| (*e, 0)).collect();
    let mut cns_cents = 0i64;
    let mut unapplied_cents = 0i64;

    // M1
    let mut bank = bank_in;
    sort_by_date(&mut bank, |t| (t.posted_date.as_str(), t.txn_id.as_str()))?;
    let mut seen = HashSet::new();
    let mut txns: Vec<Txn> = vec![];
    for t in bank {
        safe(t.amount, "amount_cents").map_err(|_| "amount_cents must be integer cents".to_string())?;
        if !seen.insert(t.txn_id.clone()) {
            bump(&mut ex, "duplicate_bank_txn");
            continue;
        }
        txns.push(t);
    }
    let credits: Vec<usize> = (0..txns.len()).filter(|&i| txns[i].amount > 0).collect();
    let debits: Vec<usize> = (0..txns.len()).filter(|&i| txns[i].amount < 0).collect();
    for &d in &debits {
        if let Some(rev) = txns[d].reversal_of.clone() {
            if let Some(&c) = credits.iter().find(|&&c| txns[c].txn_id == rev && !txns[c].reversed) {
                txns[c].reversed = true;
                txns[c].outcome = Some("reversed".into());
                txns[d].outcome = Some("reversal".into());
            }
        }
    }
    for &d in &debits {
        if txns[d].outcome.is_some() || txns[d].kind_hint == "distribution" || txns[d].kind_hint == "expense" {
            continue;
        }
        let dd = days(&txns[d].posted_date)?;
        let mut hit = None;
        for &c in &credits {
            let gap = dd - days(&txns[c].posted_date)?;
            if !txns[c].reversed && txns[c].counterparty_ref == txns[d].counterparty_ref && txns[c].amount == -txns[d].amount && (0..=REVERSAL_WINDOW_DAYS).contains(&gap) {
                hit = Some(c);
                break;
            }
        }
        if let Some(c) = hit {
            txns[c].reversed = true;
            txns[c].outcome = Some("reversed".into());
            txns[d].outcome = Some("reversal".into());
            bump(&mut ex, "probable_reversal");
        }
    }

    let mut claims_in = src.claims;
    sort_by_date(&mut claims_in, |c| (c.paid_date.as_str(), c.claim_id.as_str()))?;
    let mut seen_claim = HashSet::new();
    let mut cl: Vec<Claim> = vec![];
    for c in claims_in {
        safe(c.amount, "amount_cents").map_err(|_| "amount_cents must be integer cents".to_string())?;
        let key = format!("{}|{}|{}|{}", c.unit_ref, c.paid_date, c.amount, c.status);
        if !seen_claim.insert(key) {
            bump(&mut ex, "duplicate_claim");
            continue;
        }
        cl.push(c);
    }
    let reversed_idx: Vec<usize> = (0..cl.len()).filter(|&i| cl[i].status == "reversed").collect();
    for r in reversed_idx {
        let rd = days(&cl[r].paid_date)?;
        let mut hit = None;
        for i in 0..cl.len() {
            if cl[i].status != "reversed" && cl[i].outcome.is_none() && cl[i].unit_ref == cl[r].unit_ref && cl[i].amount == cl[r].amount && days(&cl[i].paid_date)? <= rd {
                hit = Some(i);
                break;
            }
        }
        if let Some(i) = hit {
            cl[i].outcome = Some("reversed_by_manager".into());
        }
        cl[r].outcome = Some("reversal_record".into());
    }
    cl.retain(|c| c.status != "reversed");
    let live: Vec<usize> = (0..cl.len()).filter(|&i| cl[i].outcome.as_deref() != Some("reversed_by_manager")).collect();

    // M2
    let mut dues = src.due;
    sort_by_date(&mut dues, |d| (d.due_date.as_str(), d.due_id.as_str()))?;
    let due_index: HashMap<String, usize> = dues.iter().enumerate().map(|(i, d)| (d.due_id.clone(), i)).collect();
    for &ci in &live {
        let c = &cl[ci];
        let mut d = c.due_id.as_ref().and_then(|id| due_index.get(id).copied());
        if let Some(di) = d {
            if dues[di].unit_ref != c.unit_ref {
                d = None;
            }
        }
        if d.is_none() && c.due_id.is_none() {
            d = dues.iter().position(|x| x.unit_ref == c.unit_ref && x.amount_due - x.claimed >= c.amount);
        }
        match d {
            None => {
                cl[ci].outcome = Some("claim_without_due".into());
                bump(&mut ex, "claim_without_due");
            }
            Some(di) => {
                cl[ci].linked_due = Some(dues[di].due_id.clone());
                dues[di].claimed += cl[ci].amount;
            }
        }
    }

    // M3
    let in_window = |paid: &str, posted: &str| -> R<bool> {
        let diff = days(posted)? - days(paid)?;
        Ok((-SETTLE_BEFORE..=SETTLE_AFTER).contains(&diff))
    };
    let free = |t: &Txn| !t.reversed && t.used == 0 && !not_income(&t.kind_hint);
    for &ci in &live {
        if cl[ci].linked_due.is_none() {
            continue;
        }
        let mut hit = None;
        for &x in &credits {
            if free(&txns[x]) && payers.get(&txns[x].counterparty_ref) == Some(&cl[ci].unit_ref) && txns[x].amount == cl[ci].amount && in_window(&cl[ci].paid_date, &txns[x].posted_date)? {
                hit = Some(x);
                break;
            }
        }
        if let Some(x) = hit {
            txns[x].used = txns[x].amount;
            txns[x].outcome = Some("settles_claim".into());
            cl[ci].settled_by = Some(txns[x].txn_id.clone());
        }
    }
    let mut groups: Vec<(String, Vec<usize>)> = vec![];
    for &ci in &live {
        if cl[ci].linked_due.is_none() || cl[ci].settled_by.is_some() {
            continue;
        }
        let k = cl[ci].batch_ref.clone().unwrap_or_else(|| format!("date:{}", cl[ci].paid_date));
        match groups.iter_mut().find(|(gk, _)| *gk == k) {
            Some((_, g)) => g.push(ci),
            None => groups.push((k, vec![ci])),
        }
    }
    groups.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
    for (_, g) in &groups {
        let sum: i64 = g.iter().map(|&ci| cl[ci].amount).sum();
        let mut paids: Vec<&str> = g.iter().map(|&ci| cl[ci].paid_date.as_str()).collect();
        paids.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        let paid = paids[0].to_string();
        let mut candidates = vec![];
        for &x in &credits {
            if free(&txns[x]) && !payers.contains_key(&txns[x].counterparty_ref) && in_window(&paid, &txns[x].posted_date)? {
                candidates.push(x);
            }
        }
        let exact = candidates.iter().copied().find(|&x| txns[x].amount == sum);
        match exact {
            Some(x) if g.len() > 1 => {
                txns[x].used = sum;
                txns[x].outcome = Some("settles_batch".into());
                for &ci in g {
                    cl[ci].settled_by = Some(txns[x].txn_id.clone());
                }
            }
            _ => {
                if g.len() > 1 && candidates.iter().any(|&x| txns[x].kind_hint == "rent" || txns[x].kind_hint == "loan_payment") {
                    bump(&mut ex, "batch_mismatch");
                }
            }
        }
    }

    // M4
    for &ci in &live {
        if cl[ci].settled_by.is_some() {
            let di = due_index[cl[ci].linked_due.as_ref().unwrap()];
            dues[di].settled += cl[ci].amount;
            if cl[ci].outcome.is_none() {
                cl[ci].outcome = Some("settled".into());
            }
        } else if cl[ci].outcome.is_none() {
            cl[ci].outcome = Some("claimed_not_settled".into());
            bump(&mut ex, "claimed_not_settled");
            cns_cents += cl[ci].amount;
        }
    }
    let payer_credits: Vec<usize> = credits.iter().copied().filter(|&x| free(&txns[x]) && payers.contains_key(&txns[x].counterparty_ref)).collect();
    for x in payer_credits {
        let unit = payers[&txns[x].counterparty_ref].clone();
        let mut left = txns[x].amount;
        for d in dues.iter_mut().filter(|d| d.unit_ref == unit) {
            let open = d.amount_due - d.settled;
            if open <= 0 || left <= 0 {
                continue;
            }
            let take = open.min(left);
            d.settled += take;
            left -= take;
        }
        txns[x].used = txns[x].amount - left;
        txns[x].outcome = Some(if txns[x].used > 0 { "settled_not_claimed" } else { "unapplied_credit" }.into());
        if txns[x].used > 0 {
            bump(&mut ex, "settled_not_claimed");
        }
        if left > 0 {
            bump(&mut ex, "unapplied_credit");
            unapplied_cents += left;
        }
    }
    for d in dues.iter_mut() {
        d.status = if d.settled >= d.amount_due { "paid_full" } else if d.settled > 0 { "paid_partial" } else { "unpaid" };
    }

    // M5
    for &x in &credits {
        if !txns[x].reversed && txns[x].used == 0 && txns[x].outcome.is_none() {
            txns[x].outcome = Some(if not_income(&txns[x].kind_hint) { txns[x].kind_hint.clone() } else { "unattributed".into() });
        }
    }
    for &d in &debits {
        if txns[d].kind_hint != "distribution" || txns[d].outcome.is_some() {
            continue;
        }
        let dd = days(&txns[d].posted_date)?;
        let mut funded = false;
        for &c in &credits {
            let gap = dd - days(&txns[c].posted_date)?;
            if txns[c].outcome.as_deref() == Some("owner_transfer") && (0..=SPONSOR_WINDOW_DAYS).contains(&gap) {
                funded = true;
                break;
            }
        }
        txns[d].funded_by_sponsor = Some(funded);
        if funded {
            bump(&mut ex, "distribution_funded_by_sponsor");
        }
    }

    let claimed_cash_cents = live.iter().filter(|&&ci| cl[ci].outcome.as_deref() != Some("claim_without_due")).map(|&ci| cl[ci].amount).sum();
    Ok(Matched { due: dues, claims: cl, bank: txns, exceptions: ex, claimed_not_settled_cents: cns_cents, unapplied_credit_cents: unapplied_cents, claimed_cash_cents })
}

/// The match output in the reference's shape.
pub fn matched_json(m: &Matched) -> Value {
    let opt = |o: &Option<String>| o.as_ref().map(|x| Value::String(x.clone())).unwrap_or(Value::Null);
    let due: Vec<Value> = m
        .due
        .iter()
        .map(|d| json!({ "due_id": d.due_id, "unit_ref": d.unit_ref, "component": d.component, "period": d.period, "due_date": d.due_date, "amount_due_cents": d.amount_due, "settled_cents": d.settled, "status": d.status }))
        .collect();
    let claims: Vec<Value> = m
        .claims
        .iter()
        .map(|c| json!({ "claim_id": c.claim_id, "unit_ref": c.unit_ref, "paid_date": c.paid_date, "amount_cents": c.amount, "linked_due": opt(&c.linked_due), "settled_by": opt(&c.settled_by), "outcome": opt(&c.outcome) }))
        .collect();
    let bank: Vec<Value> = m
        .bank
        .iter()
        .map(|t| {
            let outcome = t.outcome.clone().unwrap_or_else(|| if t.amount < 0 { t.kind_hint.clone() } else { "unattributed".into() });
            let mut o = json!({ "txn_id": t.txn_id, "posted_date": t.posted_date, "amount_cents": t.amount, "kind_hint": t.kind_hint, "used_cents": t.used, "outcome": outcome });
            if let Some(f) = t.funded_by_sponsor {
                o["funded_by_sponsor"] = Value::Bool(f);
            }
            o
        })
        .collect();
    let mut ex = Map::new();
    for (k, v) in &m.exceptions {
        ex.insert((*k).into(), json!(v));
    }
    json!({ "due": due, "claims": claims, "bank": bank, "exceptions": ex, "amounts": { "claimed_not_settled_cents": m.claimed_not_settled_cents, "unapplied_credit_cents": m.unapplied_credit_cents }, "claimed_cash_cents": m.claimed_cash_cents })
}
