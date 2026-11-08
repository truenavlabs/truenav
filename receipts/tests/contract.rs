// Receipt contract unit tests (near-sdk mocked chain). The receipts are what the engine module really prints for
// the 4 synthetic funds (tests/fixtures/engine-receipts.json); each test patches in the nonce this contract chose.
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, AccountId, Gas, NearToken, PromiseResult, RuntimeFeesConfig};
use truenav_receipts::{Config, Receipts};

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
const PIN: &str = "360cd47346db7060ffb213288e25a6d5e39050133bd4e20ad2f6f9280b1daa57";

fn config() -> Config {
    Config {
        outlayer: acc("outlayer.testnet"),
        project_id: "receipts.truenav.testnet/truenav-engine".into(),
        version_key: PIN.into(),
        method: "cashflow-v2.1.0".into(),
        secrets_profile: "engine".into(),
        secrets_owner: acc("receipts.truenav.testnet"),
        max_instructions: 10_000_000_000,
        max_memory_mb: 128,
        max_execution_seconds: 30,
        outlayer_deposit: U128(NearToken::from_millinear(10).as_yoctonear()),
        storage_deposit: U128(NearToken::from_millinear(250).as_yoctonear()),
        outlayer_tgas: 230,
        callback_tgas: 50,
    }
}
fn ctx(who: &str, deposit: NearToken) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("receipts.truenav.testnet")).predecessor_account_id(acc(who)).signer_account_id(acc(who)).attached_deposit(deposit).prepaid_gas(Gas::from_tgas(300)).account_balance(NearToken::from_near(10));
    b
}
fn set(who: &str, deposit: NearToken, results: Vec<PromiseResult>) {
    testing_env!(ctx(who, deposit).build(), near_sdk::test_vm_config(), RuntimeFeesConfig::test(), Default::default(), results);
}
fn fixture(id: &str) -> Value {
    let f: Value = serde_json::from_str(include_str!("fixtures/engine-receipts.json")).unwrap();
    serde_json::from_str(f["receipts"][id]["output"].as_str().unwrap()).unwrap()
}
fn setup() -> Receipts {
    set("admin.testnet", NearToken::from_yoctonear(1), vec![]);
    let mut c = Receipts::new(acc("admin.testnet"), acc("pauser.testnet"), config());
    set("admin.testnet", NearToken::from_yoctonear(1), vec![]);
    c.set_runner(acc("runner.testnet"), true);
    for (t, k) in [("DEMO-CREDIT", "credit"), ("DEMO-RENTAL", "rental"), ("HONEST-CREDIT", "credit"), ("HONEST-RENTAL", "rental")] {
        c.register_token(t.into(), k.into());
    }
    c
}
fn attach() -> NearToken {
    NearToken::from_millinear(260)
}
/// request a run, then deliver `output` (or a failure) to the callback; returns the callback's result code
fn run_with(c: &mut Receipts, token: &str, make: impl Fn(&str) -> Option<Vec<u8>>) -> String {
    set("runner.testnet", attach(), vec![]);
    let _ = c.request_run(token.into());
    let p = c.get_token(token.into()).unwrap()["pending"].clone();
    let nonce = p["run_nonce"].as_str().unwrap().to_string();
    let rid = p["request_id"].as_u64().unwrap();
    let result = match make(&nonce) {
        Some(b) => PromiseResult::Successful(b),
        None => PromiseResult::Failed,
    };
    set("receipts.truenav.testnet", NearToken::from_yoctonear(0), vec![result]);
    c.on_run_result(token.into(), rid)
}
type Case = (&'static str, Box<dyn Fn(&mut Value)>);

fn engine_output(token: &str, nonce: &str, edit: impl Fn(&mut Value)) -> Vec<u8> {
    let mut v = fixture(token);
    v["run_nonce"] = json!(nonce);
    edit(&mut v);
    v.to_string().into_bytes()
}

#[test]
fn all_four_engine_receipts_are_accepted_and_indexed() {
    let mut c = setup();
    for (t, score, band) in [("DEMO-CREDIT", 58, "red"), ("DEMO-RENTAL", 58, "red"), ("HONEST-CREDIT", 97, "green"), ("HONEST-RENTAL", 100, "green")] {
        assert_eq!(run_with(&mut c, t, |n| Some(engine_output(t, n, |_| {}))), "stored:1", "{t}");
        let r = c.get_latest(t.into()).unwrap();
        assert_eq!((r.seq, r.score, r.band.as_str(), r.version_key.as_str(), r.method.as_str()), (1, score, band, PIN, "cashflow-v2.1.0"));
        assert_eq!(r.period, "2026-10");
        assert_eq!(r.receipt_sha256.len(), 64);
        assert!(c.get_token(t.into()).unwrap()["pending"].is_null());
    }
    assert_eq!(c.get_latest("DEMO-CREDIT".into()).unwrap().caps, vec!["yield_gap", "claimed_not_settled", "collection_shortfall"]);
    assert!(c.get_latest("HONEST-RENTAL".into()).unwrap().caps.is_empty());
}

#[test]
fn the_request_carries_only_token_and_nonce_and_pins_the_build() {
    let mut c = setup();
    set("runner.testnet", attach(), vec![]);
    let _ = c.request_run("HONEST-CREDIT".into());
    let logs = get_logs();
    let ev = logs.iter().find(|l| l.contains("run_requested")).unwrap();
    assert!(ev.contains(PIN));
    let p = c.get_token("HONEST-CREDIT".into()).unwrap()["pending"].clone();
    assert_eq!(p["version_key"], PIN);
    assert_eq!(p["run_nonce"].as_str().unwrap().len(), 64);
    // a second request for the same token waits for the first
    set("runner.testnet", attach(), vec![]);
    let again = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = c.request_run("HONEST-CREDIT".into());
    }));
    assert!(again.is_err());
}

#[test]
fn sequence_numbers_grow_and_history_pages_newest_first() {
    let mut c = setup();
    for i in 1..=3u64 {
        assert_eq!(run_with(&mut c, "HONEST-CREDIT", |n| Some(engine_output("HONEST-CREDIT", n, |_| {}))), format!("stored:{i}"));
    }
    let h = c.get_history("HONEST-CREDIT".into(), None, Some(2));
    assert_eq!(h.iter().map(|r| r.seq).collect::<Vec<_>>(), vec![3, 2]);
    assert_eq!(c.get_history("HONEST-CREDIT".into(), Some(1), None).len(), 1);
    assert_eq!(c.get_receipt("HONEST-CREDIT".into(), 2).unwrap().seq, 2);
    // a different nonce per request, even under one fixed random seed
    let nonces: std::collections::HashSet<String> = (1..=3).map(|s| serde_json::from_str::<Value>(&c.get_receipt("HONEST-CREDIT".into(), s).unwrap().receipt).unwrap()["run_nonce"].as_str().unwrap().to_string()).collect();
    assert_eq!(nonces.len(), 3, "each request gets its own nonce (the seed also covers request_id)");
}

#[test]
fn a_receipt_for_another_request_token_method_or_kind_is_rejected() {
    let mut c = setup();
    let cases: Vec<Case> = vec![
        ("receipt_rejected:run_nonce", Box::new(|v| v["run_nonce"] = json!("ab".repeat(32)))),
        ("receipt_rejected:token_id", Box::new(|v| v["token_id"] = json!("DEMO-CREDIT"))),
        ("receipt_rejected:method", Box::new(|v| v["method"] = json!("cashflow-v2.0.0"))),
        ("receipt_rejected:kind", Box::new(|v| v["kind"] = json!("rental"))),
        ("receipt_rejected:receipt_version", Box::new(|v| v["receipt_version"] = json!("1"))),
    ];
    for (want, edit) in cases {
        let got = run_with(&mut c, "HONEST-CREDIT", |n| Some(engine_output("HONEST-CREDIT", n, &edit)));
        assert_eq!(got, want);
        assert!(c.get_latest("HONEST-CREDIT".into()).is_none());
        assert_eq!(c.get_token("HONEST-CREDIT".into()).unwrap()["last_failure"]["code"], want);
    }
}

#[test]
fn only_aggregates_reasons_metrics_and_document_hashes_get_on_chain() {
    let mut c = setup();
    let cases: Vec<Case> = vec![
        ("receipt_rejected:top_unknown_field_borrowers", Box::new(|v| v["borrowers"] = json!(["Borrower 1"]))),
        ("receipt_rejected:metrics_unknown_field_unit_refs", Box::new(|v| v["metrics"]["unit_refs"] = json!(["3f2a"]))),
        ("receipt_rejected:metrics_value", Box::new(|v| v["metrics"]["cash_received_cents"] = json!("Tenant DEMO 01 paid"))),
        ("receipt_rejected:metrics_exceptions", Box::new(|v| v["metrics"]["exceptions"]["payer"] = json!(1))),
        ("receipt_rejected:cohort_not_suppressed", Box::new(|v| v["metrics"]["cohorts"]["60"] = json!({ "units": 2, "outstanding_cents": 5 }))),
        ("receipt_rejected:passport_hash", Box::new(|v| v["passport"][0]["snapshot_sha256"] = json!("not-a-hash"))),
        ("receipt_rejected:passport_unknown_field_rows", Box::new(|v| v["passport"][0]["rows"] = json!(12))),
        ("receipt_rejected:evidence_hashes", Box::new(|v| v["evidence_hashes"][0]["sha256"] = json!("0".repeat(64)))),
        ("receipt_rejected:cap_code", Box::new(|v| v["caps"] = json!([{ "code": "made_up", "reason": "red because x" }]))),
        ("receipt_rejected:cap_reason", Box::new(|v| v["caps"] = json!([{ "code": "yield_gap", "reason": "the borrower Jane defaulted" }]))),
        ("receipt_rejected:cap_not_applied", Box::new(|v| v["caps"] = json!([{ "code": "yield_gap", "reason": "red because the gap" }]))),
        ("receipt_rejected:band", Box::new(|v| v["band"] = json!("red"))),
        ("receipt_rejected:missing_holds", Box::new(|v| { v.as_object_mut().unwrap().remove("holds"); })),
        ("receipt_rejected:metrics_collection", Box::new(|v| v["metrics"]["collection"]["status"] = json!("defaulted"))),
        ("receipt_rejected:metrics_value", Box::new(|v| v["metrics"]["occupancy_bps"] = json!("SENTINEL-not-a-number"))),
        ("receipt_rejected:metrics_value", Box::new(|v| v["metrics"]["occupancy_bps"] = json!(9583.5))),
        ("receipt_rejected:metrics_value", Box::new(|v| v["metrics"]["reported_yield_bps"] = json!("1100"))),
    ];
    for (want, edit) in cases {
        assert_eq!(run_with(&mut c, "HONEST-CREDIT", |n| Some(engine_output("HONEST-CREDIT", n, &edit))), want);
    }
    assert!(c.get_latest("HONEST-CREDIT".into()).is_none(), "nothing rejected was stored");
}

#[test]
fn module_errors_outlayer_failures_and_junk_store_a_failure_code_only() {
    let mut c = setup();
    let err = br#"{"error":"run_failed","method":"cashflow-v2.1.0","stage":"dues_missing"}"#.to_vec();
    assert_eq!(run_with(&mut c, "DEMO-RENTAL", |_| Some(err.clone())), "module_failed:dues_missing");
    assert_eq!(run_with(&mut c, "DEMO-RENTAL", |_| None), "outlayer_failed");
    assert_eq!(run_with(&mut c, "DEMO-RENTAL", |_| Some(b"not json".to_vec())), "receipt_not_json");
    let weird = br#"{"error":"run_failed","stage":"Name: Jane Doe"}"#.to_vec();
    assert_eq!(run_with(&mut c, "DEMO-RENTAL", |_| Some(weird.clone())), "module_failed", "a stage that is not a code is not stored");
    assert_eq!(run_with(&mut c, "DEMO-RENTAL", |_| Some(vec![b' '; 10_001])), "receipt_too_large");
    assert!(c.get_latest("DEMO-RENTAL".into()).is_none());
    // a later good run clears the failure
    assert_eq!(run_with(&mut c, "DEMO-RENTAL", |n| Some(engine_output("DEMO-RENTAL", n, |_| {}))), "stored:1");
    assert!(c.get_token("DEMO-RENTAL".into()).unwrap()["last_failure"].is_null());
}

#[test]
fn a_stale_or_unknown_callback_changes_nothing() {
    let mut c = setup();
    set("receipts.truenav.testnet", NearToken::from_yoctonear(0), vec![PromiseResult::Failed]);
    assert_eq!(c.on_run_result("HONEST-CREDIT".into(), 1), "no_pending");
    set("runner.testnet", attach(), vec![]);
    let _ = c.request_run("HONEST-CREDIT".into());
    set("receipts.truenav.testnet", NearToken::from_yoctonear(0), vec![PromiseResult::Failed]);
    assert_eq!(c.on_run_result("HONEST-CREDIT".into(), 99), "stale_callback");
    assert!(!c.get_token("HONEST-CREDIT".into()).unwrap()["pending"].is_null());
}

fn panics(f: impl FnOnce()) -> String {
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
    match r {
        Ok(_) => String::new(),
        Err(e) => e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default(),
    }
}

#[test]
fn roles_pause_deposit_and_config_are_enforced() {
    let mut c = setup();
    set("someone.testnet", attach(), vec![]);
    assert!(panics(|| drop(c.request_run("HONEST-CREDIT".into()))).contains("runner only"));
    set("runner.testnet", attach(), vec![]);
    assert!(panics(|| drop(c.request_run("NOT-REGISTERED".into()))).contains("unknown token"));
    set("runner.testnet", NearToken::from_millinear(100), vec![]);
    assert!(panics(|| drop(c.request_run("HONEST-CREDIT".into()))).contains("attach at least"));
    set("someone.testnet", NearToken::from_yoctonear(0), vec![]);
    assert!(panics(|| c.pause()).contains("pauser or admin only"));
    assert!(panics(|| c.register_token("X".into(), "credit".into())).contains("admin only"));
    assert!(panics(|| c.set_runner(acc("x.testnet"), true)).contains("admin only"));
    set("pauser.testnet", NearToken::from_yoctonear(1), vec![]);
    c.pause();
    set("runner.testnet", attach(), vec![]);
    assert!(panics(|| drop(c.request_run("HONEST-CREDIT".into()))).contains("paused"));
    set("admin.testnet", NearToken::from_yoctonear(1), vec![]);
    c.unpause();
    let mut bad = config();
    bad.version_key = "latest".into();
    assert!(panics(|| c.set_config(bad)).contains("never latest"));
    let mut cheap = config();
    cheap.storage_deposit = U128(1);
    assert!(panics(|| c.set_config(cheap)).contains("storage_deposit too low"));
    assert!(panics(|| c.register_token("lower-case".into(), "credit".into())).contains("token_id must match"));
    // admin hand-over is two-step
    c.propose_admin(acc("new-admin.testnet"));
    set("someone.testnet", NearToken::from_yoctonear(0), vec![]);
    assert!(panics(|| c.accept_admin()).contains("not the proposed admin"));
    set("new-admin.testnet", NearToken::from_yoctonear(1), vec![]);
    c.accept_admin();
    assert_eq!(c.get_config()["admin"], "new-admin.testnet");
}

#[test]
fn a_new_pinned_build_applies_to_new_requests_only() {
    let mut c = setup();
    set("runner.testnet", attach(), vec![]);
    let _ = c.request_run("HONEST-RENTAL".into());
    let rid = c.get_token("HONEST-RENTAL".into()).unwrap()["pending"]["request_id"].as_u64().unwrap();
    let nonce = c.get_token("HONEST-RENTAL".into()).unwrap()["pending"]["run_nonce"].as_str().unwrap().to_string();
    set("admin.testnet", NearToken::from_yoctonear(1), vec![]);
    let mut next = config();
    next.version_key = "ab".repeat(32);
    c.set_config(next);
    set("receipts.truenav.testnet", NearToken::from_yoctonear(0), vec![PromiseResult::Successful(engine_output("HONEST-RENTAL", &nonce, |_| {}))]);
    assert_eq!(c.on_run_result("HONEST-RENTAL".into(), rid), "stored:1");
    assert_eq!(c.get_latest("HONEST-RENTAL".into()).unwrap().version_key, PIN, "the stored build is the one the request pinned");
}

#[test]
fn admin_calls_need_exactly_one_yocto() {
    let mut c = setup();
    set("admin.testnet", NearToken::from_yoctonear(0), vec![]);
    assert!(panics(|| c.set_runner(acc("x.testnet"), true)).contains("1 yoctoNEAR"));
    set("pauser.testnet", NearToken::from_yoctonear(0), vec![]);
    assert!(panics(|| c.pause()).contains("1 yoctoNEAR"));
}

#[test]
fn the_run_input_is_built_by_the_contract_from_its_own_last_receipt() {
    let mut c = setup();
    let first = c.get_run_input("HONEST-CREDIT".into());
    let mut keys: Vec<&String> = first.as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(keys, vec!["run_nonce", "token_id"], "no previous receipt: token and nonce only, never as_of");
    assert_eq!(run_with(&mut c, "HONEST-CREDIT", |n| Some(engine_output("HONEST-CREDIT", n, |_| {}))), "stored:1");
    let next = c.get_run_input("HONEST-CREDIT".into());
    let stored: Value = serde_json::from_str(&c.get_latest("HONEST-CREDIT".into()).unwrap().receipt).unwrap();
    assert_eq!(next["previous_period"], "2026-10");
    let prev = next["previous"].as_array().unwrap();
    assert_eq!(prev.len(), 3);
    for (p, s) in prev.iter().zip(stored["passport"].as_array().unwrap()) {
        assert_eq!(p["snapshot_sha256"], s["snapshot_sha256"]);
        assert_eq!(p["as_of"], s["as_of"]);
        assert_eq!(p.as_object().unwrap().len(), 3);
    }
    assert!(next.get("as_of").is_none() && next.get("new_period").is_none());
}
