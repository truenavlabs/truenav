//! The TEE entry flow, kept free of I/O so it is tested natively: validate the public input (token id and nonce
//! only), fetch the three source documents through `Fetcher` (inside OutLayer: HTTPS with a sealed read-only token),
//! run cashflow-v2.0.0, and return the receipt as canonical JSON. The output carries aggregates, the score, the
//! passport and evidence hashes only: never a pseudonymous ref, an id, a name, a token or a value derived from a
//! secret. Errors are reduced to a fixed stage code, because in on-chain mode the output is public.
use crate::base::*;
use crate::run::{receipt, run_fund, RunOptions};
use serde_json::{json, Value};

pub struct Fetched {
    pub body: Vec<u8>,
    pub synthetic: bool,
}
pub trait Fetcher {
    /// GET <base>/v1/tokens/<token_id>/<doc> with the sealed bearer token. doc is bank-feed, manager-export or
    /// issuer-claims.
    fn get(&self, token_id: &str, doc: &str) -> Result<Fetched, String>;
}

pub struct Clock {
    /// "YYYY-MM-DDTHH:MM:SSZ" now, called before and after the bank fetch
    pub now: Box<dyn Fn() -> String>,
}

fn is_token_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'-')
}
fn is_nonce(s: &str) -> bool {
    (32..=128).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_hexdigit())
}

/// Format days since the epoch plus seconds of day as an ISO timestamp (used by the WASI clock wrapper).
pub fn iso_from_unix(secs: i64) -> String {
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    let t = secs.rem_euclid(86_400);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", t / 3600, (t / 60) % 60, t % 60)
}

fn fail(stage: &str) -> String {
    canonical(&json!({ "error": "run_failed", "stage": stage, "method": crate::metrics::METHOD })).unwrap_or_else(|_| "{\"error\":\"run_failed\"}".into())
}

/// The whole module: public input in, public receipt out.
pub fn execute(input: &str, fetch: &dyn Fetcher, pseudo: &dyn Pseudonymizer, clock: &Clock) -> String {
    match execute_inner(input, fetch, pseudo, clock) {
        Ok(s) => s,
        Err(stage) => fail(stage),
    }
}

fn execute_inner(input: &str, fetch: &dyn Fetcher, pseudo: &dyn Pseudonymizer, clock: &Clock) -> Result<String, &'static str> {
    let v: Value = serde_json::from_str(input).map_err(|_| "input_json")?;
    let o = v.as_object().ok_or("input_json")?;
    for k in o.keys() {
        if !matches!(k.as_str(), "token_id" | "run_nonce" | "as_of" | "previous" | "new_period") {
            return Err("input_unknown_field");
        }
    }
    let token_id = o.get("token_id").and_then(Value::as_str).filter(|t| is_token_id(t)).ok_or("input_token_id")?;
    let nonce = o.get("run_nonce").and_then(Value::as_str).filter(|n| is_nonce(n)).ok_or("input_run_nonce")?;
    let as_of = match o.get("as_of") {
        None | Some(Value::Null) => (clock.now)(),
        Some(Value::String(t)) if parse_ts(t).is_ok() => t.clone(),
        _ => return Err("input_as_of"),
    };
    // previous run's passport (public): [{ source, snapshot_sha256, as_of }]
    let mut previous = vec![];
    if let Some(p) = o.get("previous") {
        for e in p.as_array().ok_or("input_previous")? {
            let get = |k: &str| e.get(k).and_then(Value::as_str).map(str::to_string).ok_or("input_previous");
            previous.push((get("source")?, get("snapshot_sha256")?, get("as_of")?));
        }
    }
    let new_period = match o.get("new_period") {
        None => false,
        Some(Value::Bool(b)) => *b,
        _ => return Err("input_new_period"),
    };

    let bank = fetch.get(token_id, "bank-feed").map_err(|_| "fetch_bank_feed")?;
    let bank_fetched_at = (clock.now)();
    let mgr = fetch.get(token_id, "manager-export").map_err(|_| "fetch_manager_export")?;
    let issuer = fetch.get(token_id, "issuer-claims").map_err(|_| "fetch_issuer_claims")?;
    let parse = |f: &Fetched, stage: &'static str| -> Result<Value, &'static str> { serde_json::from_slice::<Value>(&f.body).map_err(|_| stage) };
    let bank_v = parse(&bank, "parse_bank_feed")?;
    let mgr_v = parse(&mgr, "parse_manager_export")?;
    let issuer_v = parse(&issuer, "parse_issuer_claims")?;
    if issuer_v.get("token_id").and_then(Value::as_str) != Some(token_id) {
        return Err("issuer_token_mismatch");
    }
    let kind = if mgr_v.get("loans").is_some() { "credit" } else if mgr_v.get("units").is_some() { "rental" } else { return Err("manager_export_shape") };
    let period = issuer_v.get("period").and_then(Value::as_str).filter(|p| p.len() == 7 && days(&format!("{p}-01")).is_ok()).ok_or("issuer_period")?.to_string();
    let (y, m): (i64, i64) = (period[0..4].parse().map_err(|_| "issuer_period")?, period[5..7].parse().map_err(|_| "issuer_period")?);
    let mgr_key = if kind == "credit" { "servicer_tape" } else { "manager_export" };
    let ds = json!({ "id": token_id, "kind": kind, "synthetic": mgr.synthetic && issuer.synthetic, "bank_feed": bank_v, mgr_key: mgr_v, "issuer": issuer_v });
    let opts = RunOptions { as_of: &as_of, period: &period, days_in_period: month_len(y, m), bank_fetched_at: &bank_fetched_at, previous, new_period };
    let r = run_fund(&ds, pseudo, &opts).map_err(|_| "run")?;
    let mut rec = receipt(&r, nonce, &as_of).map_err(|_| "receipt")?;
    // the bank's own synthetic label comes from the response, not from the document
    if !bank.synthetic && rec["synthetic"] == json!(true) {
        rec["synthetic"] = json!(mgr.synthetic || issuer.synthetic);
    }
    canonical(&rec).map_err(|_| "receipt")
}
