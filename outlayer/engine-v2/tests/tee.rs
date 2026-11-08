// The TEE entry flow (src/tee.rs) run natively with a fake fetcher that serves each parity fund's three documents
// the way the mock bank-data API does. Checks: the receipt agrees with the parity reference; nothing private or
// secret-derived reaches the output; bad input and failed fetches fail closed with a fixed stage code only.
use serde_json::{json, Value};
use std::cell::Cell;
use std::fs;
use truenav_engine_v2::base::{js_stringify, SeedPseudonymizer};
use truenav_engine_v2::tee::{execute, Clock, Fetched, Fetcher};

const TOKEN: &str = "sealed-bearer-token-for-tests-only"; // gitleaks:allow (test value, not a secret)
const NONCE: &str = "00112233445566778899aabbccddeeff";

fn fixture(name: &str) -> Value {
    let p = format!("{}/../../cashflow/fixtures/parity/cashflow-parity-{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&fs::read_to_string(p).unwrap()).unwrap()
}

struct Fake {
    ds: Value,
    fail: Option<&'static str>,
    calls: Cell<u32>,
}
impl Fetcher for Fake {
    fn get(&self, token_id: &str, doc: &str) -> Result<Fetched, String> {
        self.calls.set(self.calls.get() + 1);
        if self.fail == Some(doc) {
            return Err(format!("connection refused to secret host with {TOKEN}"));
        }
        assert_eq!(token_id, self.ds["id"].as_str().unwrap());
        let mgr = if self.ds["kind"] == "credit" { "servicer_tape" } else { "manager_export" };
        let v = match doc {
            "bank-feed" => &self.ds["bank_feed"],
            "manager-export" => &self.ds[mgr],
            "issuer-claims" => &self.ds["issuer"],
            _ => panic!("unexpected doc {doc}"),
        };
        // the bytes a server sends; js_stringify refuses floats, so a document that has one goes out as plain JSON
        let body = js_stringify(v).unwrap_or_else(|_| v.to_string());
        Ok(Fetched { body: body.into_bytes(), synthetic: true })
    }
}

fn run(name: &str, input: Value, fail: Option<&'static str>) -> (String, Value) {
    let fx = fixture(name);
    let fake = Fake { ds: fx["input"]["dataset"].clone(), fail, calls: Cell::new(0) };
    let clock = Clock { now: Box::new(|| "2026-11-08T08:30:00Z".to_string()) };
    let p = SeedPseudonymizer(fx["input"]["pseudonym_seed"].as_str().unwrap().as_bytes().to_vec());
    let out = execute(&input.to_string(), &fake, &p, &clock);
    (out, fx)
}
fn good_input(token: &str) -> Value {
    json!({ "token_id": token, "run_nonce": NONCE, "as_of": "2026-11-08T09:00:00Z" })
}

#[test]
fn receipt_agrees_with_the_parity_reference_for_all_four_funds() {
    for name in ["DEMO-CREDIT", "DEMO-RENTAL", "HONEST-CREDIT", "HONEST-RENTAL"] {
        let (out, fx) = run(name, good_input(name), None);
        let rec: Value = serde_json::from_str(&out).unwrap();
        let want: Value = serde_json::from_str(fx["expected_output"].as_str().unwrap()).unwrap();
        assert_eq!(rec["score"], want["score"]["score"], "{name}");
        assert_eq!(rec["band"], want["score"]["band"], "{name}");
        assert_eq!(rec["caps"], want["score"]["caps"], "{name}");
        assert_eq!(rec["raw_x100"], want["score"]["raw_x100"], "{name}");
        assert_eq!(rec["metrics"], want["public_metrics"], "{name}");
        assert_eq!(rec["passport"], want["passport"], "{name}: snapshot hashes of the fetched bytes equal the reference");
        assert_eq!(rec["run_nonce"], NONCE);
        assert_eq!(rec["synthetic"], true);
        assert!(rec["receipt_sha256"].as_str().unwrap().len() == 64);
    }
}

#[test]
fn nothing_private_or_secret_derived_reaches_the_output() {
    for name in ["DEMO-CREDIT", "DEMO-RENTAL", "HONEST-CREDIT", "HONEST-RENTAL"] {
        let (out, fx) = run(name, good_input(name), None);
        let want: Value = serde_json::from_str(fx["expected_output"].as_str().unwrap()).unwrap();
        let ds = &fx["input"]["dataset"];
        let mut forbidden: Vec<String> = vec![TOKEN.into(), fx["input"]["pseudonym_seed"].as_str().unwrap().into()];
        for d in want["match"]["due"].as_array().unwrap() {
            forbidden.push(d["unit_ref"].as_str().unwrap().into());
            forbidden.push(d["due_id"].as_str().unwrap().into());
        }
        for c in want["match"]["claims"].as_array().unwrap() {
            forbidden.push(c["claim_id"].as_str().unwrap().into());
        }
        for t in want["match"]["bank"].as_array().unwrap() {
            forbidden.push(t["txn_id"].as_str().unwrap().into());
        }
        for t in ds["bank_feed"]["transactions"].as_array().unwrap() {
            forbidden.push(t["counterparty"].as_str().unwrap().into());
        }
        if ds["kind"] == "credit" {
            for l in ds["servicer_tape"]["loans"].as_array().unwrap() {
                forbidden.push(l["loan_id"].as_str().unwrap().into());
                forbidden.push(l["borrower_payer"].as_str().unwrap().into());
            }
        } else {
            for u in ds["manager_export"]["units"].as_array().unwrap() {
                forbidden.push(u["unit_id"].as_str().unwrap().into());
                if let Some(t) = u["tenant_payer"].as_str() {
                    forbidden.push(t.into());
                }
            }
        }
        for f in &forbidden {
            assert!(!out.contains(f.as_str()), "{name}: output contains {f}");
        }
    }
}

#[test]
fn bad_input_fails_closed_with_a_stage_code_only() {
    let cases = [
        (json!({ "token_id": "DEMO-CREDIT", "run_nonce": NONCE, "extra": 1 }), "input_unknown_field"),
        (json!({ "token_id": "demo-credit", "run_nonce": NONCE }), "input_token_id"),
        (json!({ "token_id": "DEMO-CREDIT", "run_nonce": "abc" }), "input_run_nonce"),
        (json!({ "token_id": "DEMO-CREDIT", "run_nonce": NONCE, "as_of": "yesterday" }), "input_as_of"),
        (json!({ "token_id": "DEMO-CREDIT" }), "input_run_nonce"),
    ];
    for (input, stage) in cases {
        let (out, _) = run("DEMO-CREDIT", input, None);
        assert_eq!(out, format!("{{\"error\":\"run_failed\",\"method\":\"cashflow-v2.1.0\",\"stage\":\"{stage}\"}}"));
    }
}

#[test]
fn a_failed_fetch_reports_the_stage_and_never_the_error_text() {
    for (doc, stage) in [("bank-feed", "fetch_bank_feed"), ("manager-export", "fetch_manager_export"), ("issuer-claims", "fetch_issuer_claims")] {
        let (out, _) = run("DEMO-RENTAL", good_input("DEMO-RENTAL"), Some(doc));
        assert!(out.contains(stage), "{out}");
        assert!(!out.contains(TOKEN) && !out.contains("secret host"), "{out}");
    }
}

#[test]
fn issuer_claims_for_another_token_are_refused() {
    let fx = fixture("DEMO-CREDIT");
    let mut ds = fx["input"]["dataset"].clone();
    ds["id"] = json!("OTHER-TOKEN");
    let fake = Fake { ds, fail: None, calls: Cell::new(0) };
    let clock = Clock { now: Box::new(|| "2026-11-08T08:30:00Z".to_string()) };
    let p = SeedPseudonymizer(b"parity-fixture-pseudonym-seed-0001".to_vec());
    let out = execute(&good_input("OTHER-TOKEN").to_string(), &fake, &p, &clock);
    assert!(out.contains("issuer_token_mismatch"), "{out}");
}

#[test]
fn the_output_is_canonical_json() {
    let (out, _) = run("HONEST-RENTAL", good_input("HONEST-RENTAL"), None);
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(truenav_engine_v2::base::canonical(&v).unwrap(), out);
}

#[test]
fn receipt_sizes_stay_small_enough_for_on_chain_delivery() {
    for name in ["DEMO-CREDIT", "DEMO-RENTAL", "HONEST-CREDIT", "HONEST-RENTAL"] {
        let (out, _) = run(name, good_input(name), None);
        eprintln!("{name}: receipt {} bytes", out.len());
        assert!(out.len() < 8 * 1024, "{name}: receipt {} bytes", out.len());
    }
}

#[test]
fn a_source_without_as_of_fails_closed_with_its_named_stage() {
    let fx = fixture("DEMO-RENTAL");
    let mut ds = fx["input"]["dataset"].clone();
    ds["issuer"]["as_of"] = Value::Null;
    let fake = Fake { ds, fail: None, calls: Cell::new(0) };
    let clock = Clock { now: Box::new(|| "2026-11-08T08:30:00Z".to_string()) };
    let p = SeedPseudonymizer(b"parity-fixture-pseudonym-seed-0001".to_vec());
    let out = execute(&good_input("DEMO-RENTAL").to_string(), &fake, &p, &clock);
    assert_eq!(out, "{\"error\":\"run_failed\",\"method\":\"cashflow-v2.1.0\",\"stage\":\"as_of_missing_issuer_claims\"}");
    let bad_prev = json!({ "token_id": "DEMO-RENTAL", "run_nonce": NONCE, "previous": [{ "source": "bank_settlements", "snapshot_sha256": "00", "as_of": "yesterday" }], "previous_period": "2026-09" });
    let (out, _) = run("DEMO-RENTAL", bad_prev, None);
    assert!(out.ends_with("\"stage\":\"as_of_invalid_previous\"}"), "{out}");
}

#[test]
fn an_input_as_of_with_an_offset_gives_the_same_receipt_as_z() {
    let (z, _) = run("DEMO-CREDIT", good_input("DEMO-CREDIT"), None);
    let (plus7, _) = run("DEMO-CREDIT", json!({ "token_id": "DEMO-CREDIT", "run_nonce": NONCE, "as_of": "2026-11-08T16:00:00+07:00" }), None);
    assert_eq!(plus7, z);
    assert!(z.contains("\"as_of\":\"2026-11-08T09:00:00Z\""));
}

#[test]
fn the_receipt_carries_collection_and_holds_and_dues_failures_fail_closed() {
    let (out, _) = run("DEMO-CREDIT", good_input("DEMO-CREDIT"), None);
    let rec: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(rec["metrics"]["collection"]["status"], "verified");
    assert_eq!(rec["metrics"]["collection"]["rate_bps"], 7857);
    assert!(rec["caps"].as_array().unwrap().iter().any(|c| c["code"] == "collection_shortfall"));
    assert_eq!(rec["holds"], json!([]));
    let fx = fixture("DEMO-RENTAL");
    let mut ds = fx["input"]["dataset"].clone();
    ds["manager_export"]["charges"] = Value::Null;
    let fake = Fake { ds, fail: None, calls: Cell::new(0) };
    let clock = Clock { now: Box::new(|| "2026-11-08T08:30:00Z".to_string()) };
    let p = SeedPseudonymizer(b"parity-fixture-pseudonym-seed-0001".to_vec());
    let out = execute(&good_input("DEMO-RENTAL").to_string(), &fake, &p, &clock);
    assert_eq!(out, "{\"error\":\"run_failed\",\"method\":\"cashflow-v2.1.0\",\"stage\":\"dues_missing\"}");
}

#[test]
fn a_string_occupancy_fails_closed_and_is_never_echoed() {
    for bad in [json!("SENTINEL-not-a-number"), json!(9583.5), json!(-1), json!(10001)] {
        let fx = fixture("HONEST-RENTAL");
        let mut ds = fx["input"]["dataset"].clone();
        ds["issuer"]["occupancy_bps"] = bad.clone();
        let fake = Fake { ds, fail: None, calls: Cell::new(0) };
        let clock = Clock { now: Box::new(|| "2026-11-08T08:30:00Z".to_string()) };
        let p = SeedPseudonymizer(b"parity-fixture-pseudonym-seed-0001".to_vec());
        let out = execute(&good_input("HONEST-RENTAL").to_string(), &fake, &p, &clock);
        assert_eq!(out, "{\"error\":\"run_failed\",\"method\":\"cashflow-v2.1.0\",\"stage\":\"occupancy_bps_invalid\"}", "{bad}");
    }
}

#[test]
fn new_period_comes_from_the_tee_never_from_input() {
    // new_period as input is refused; previous needs previous_period (both come from the receipt contract's state)
    let (out, _) = run("HONEST-CREDIT", json!({ "token_id": "HONEST-CREDIT", "run_nonce": NONCE, "new_period": true }), None);
    assert!(out.ends_with("\"stage\":\"input_unknown_field\"}"), "{out}");
    let (first, _) = run("HONEST-CREDIT", good_input("HONEST-CREDIT"), None);
    let rec: Value = serde_json::from_str(&first).unwrap();
    let previous: Vec<Value> = rec["passport"].as_array().unwrap().iter().map(|p| json!({ "source": p["source"], "snapshot_sha256": p["snapshot_sha256"], "as_of": p["as_of"] })).collect();
    let (out, _) = run("HONEST-CREDIT", json!({ "token_id": "HONEST-CREDIT", "run_nonce": NONCE, "as_of": "2026-11-08T09:00:00Z", "previous": previous }), None);
    assert!(out.ends_with("\"stage\":\"input_previous_period\"}"), "{out}");
    let (out, _) = run("HONEST-CREDIT", json!({ "token_id": "HONEST-CREDIT", "run_nonce": NONCE, "previous_period": "2026-13" }), None);
    assert!(out.ends_with("\"stage\":\"input_previous_period\"}"), "{out}");
    // same period as the issuer's: not a new period, nothing carried forward, receipt as before
    let same = json!({ "token_id": "HONEST-CREDIT", "run_nonce": NONCE, "as_of": "2026-11-08T09:00:00Z", "previous": previous, "previous_period": "2026-10" });
    let (out, _) = run("HONEST-CREDIT", same, None);
    assert_eq!(out, first);
    // the previous receipt was for an earlier period and the documents did not change: carried forward, so red
    let older = json!({ "token_id": "HONEST-CREDIT", "run_nonce": NONCE, "as_of": "2026-11-08T09:00:00Z", "previous": previous, "previous_period": "2026-09" });
    let (out, _) = run("HONEST-CREDIT", older, None);
    let r: Value = serde_json::from_str(&out).unwrap();
    assert!(r["passport"].as_array().unwrap().iter().all(|p| p["carried_forward"] == json!(true)), "{out}");
    assert!(r["caps"].as_array().unwrap().iter().any(|c| c["code"] == "self_reported_only"));
}
