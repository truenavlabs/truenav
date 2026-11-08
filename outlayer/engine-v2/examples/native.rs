//! Native stand-in for the OutLayer worker in local tests (never deployed): runs the same `tee::execute` the wasm
//! runs, with the three documents served from a local dataset file instead of the HTTPS fetch, and the public seed
//! pseudonymizer instead of OutLayer's key. Prints exactly what the module would print.
//!
//!   echo '{"token_id":"DEMO-CREDIT","run_nonce":"<hex>"}' | cargo run -q --example native -- <dataset.json> [now]
use serde_json::Value;
use std::io::Read;
use truenav_engine_v2::base::{js_stringify, SeedPseudonymizer};
use truenav_engine_v2::tee::{execute, Clock, Fetched, Fetcher};

struct FileFetcher(Value);
impl Fetcher for FileFetcher {
    fn get(&self, token_id: &str, doc: &str) -> Result<Fetched, String> {
        if self.0["id"].as_str() != Some(token_id) {
            return Err("unknown token".into());
        }
        let mgr = if self.0["kind"] == "credit" { "servicer_tape" } else { "manager_export" };
        let key = match doc {
            "bank-feed" => "bank_feed",
            "manager-export" => mgr,
            "issuer-claims" => "issuer",
            _ => return Err("unknown document".into()),
        };
        Ok(Fetched { body: js_stringify(&self.0[key])?.into_bytes(), synthetic: true })
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let ds: Value = serde_json::from_str(&std::fs::read_to_string(&args[1]).expect("dataset file")).expect("dataset json");
    let now = args.get(2).cloned().unwrap_or_else(|| "2026-11-08T08:30:00Z".into());
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).expect("stdin");
    let clock = Clock { now: Box::new(move || now.clone()) };
    let p = SeedPseudonymizer(b"parity-fixture-pseudonym-seed-0001".to_vec());
    print!("{}", execute(input.trim(), &FileFetcher(ds), &p, &clock));
}
