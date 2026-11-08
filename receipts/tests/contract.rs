// Receipt contract unit tests (near-sdk mocked chain). The receipts are what the engine module really prints for
// the 4 synthetic funds (tests/fixtures/engine-receipts.json); each test patches in the nonce this contract chose.
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
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
    for (t, score, band) in [("DEMO-CREDIT", 58, "red"), ("DEMO-RENTAL", 58, "red"), ("HONEST-CREDIT", 100, "green"), ("HONEST-RENTAL", 100, "green")] {
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
        ("receipt_rejected:top_fields", Box::new(|v| v["borrowers"] = json!(["Borrower 1"]))),
        ("receipt_rejected:top_fields", Box::new(|v| v["Jane_Doe_SSN_123"] = json!(1))),
        ("receipt_rejected:metrics_fields", Box::new(|v| v["metrics"]["unit_refs"] = json!(["3f2a"]))),
        ("receipt_rejected:metrics_fields", Box::new(|v| v["metrics"] = json!({}))),
        ("receipt_rejected:metrics_fields", Box::new(|v| { v["metrics"].as_object_mut().unwrap().remove("reported_yield_bps"); })),
        ("receipt_rejected:metrics_fields", Box::new(|v| v["metrics"]["occupancy_bps"] = json!(9583))),
        ("receipt_rejected:metrics_value", Box::new(|v| v["metrics"]["cash_received_cents"] = json!("Tenant DEMO 01 paid"))),
        ("receipt_rejected:metrics_exceptions", Box::new(|v| v["metrics"]["exceptions"]["payer"] = json!(1))),
        ("receipt_rejected:cohort_not_suppressed", Box::new(|v| v["metrics"]["cohorts"]["60"] = json!({ "units": 2, "outstanding_cents": 5 }))),
        ("receipt_rejected:passport_hash", Box::new(|v| v["passport"][0]["snapshot_sha256"] = json!("not-a-hash"))),
        ("receipt_rejected:passport", Box::new(|v| v["passport"][0]["rows"] = json!(12))),
        ("receipt_rejected:evidence_hashes", Box::new(|v| v["evidence_hashes"][0]["sha256"] = json!("0".repeat(64)))),
        ("receipt_rejected:caps", Box::new(|v| v["caps"] = json!([{ "code": "made_up", "reason": "red because x" }]))),
        ("receipt_rejected:caps", Box::new(|v| v["caps"] = json!([{ "code": "yield_gap", "reason": "the borrower Jane defaulted" }]))),
        // free text after "red because" used to pass; the reason must now be the code's exact template
        ("receipt_rejected:caps", Box::new(|v| v["caps"] = json!([{ "code": "yield_gap", "reason": "red because the reported yield is at least 3.00 percentage points above the cash yield; borrower Jane Doe, loan 1173" }]))),
        ("receipt_rejected:cap_not_applied", Box::new(|v| v["caps"] = json!([{ "code": "yield_gap", "reason": "red because the reported yield is at least 3.00 percentage points above the cash yield" }]))),
        ("receipt_rejected:collection_outcome", Box::new(|v| v["holds"] = json!([{ "code": "collection_pending", "reason": "not green because collection for the period cannot be verified yet: before the cutoff or without source coverage through it" }]))),
        ("receipt_rejected:band", Box::new(|v| v["band"] = json!("red"))),
        ("receipt_rejected:score", Box::new(|v| v["score"] = json!(101))),
        ("receipt_rejected:uncapped_score", Box::new(|v| v["uncapped_score"] = json!(99))),
        ("receipt_rejected:top_fields", Box::new(|v| { v.as_object_mut().unwrap().remove("holds"); })),
        ("receipt_rejected:metrics_collection", Box::new(|v| v["metrics"]["collection"]["status"] = json!("defaulted"))),
        ("receipt_rejected:metrics_collection", Box::new(|v| v["metrics"]["collection"]["rate_bps"] = json!(9999))),
        ("receipt_rejected:metrics_value", Box::new(|v| v["metrics"]["reported_yield_bps"] = json!("1100"))),
        ("receipt_rejected:metrics_value", Box::new(|v| v["metrics"]["cash_match_bps"] = json!(9583.5))),
        ("receipt_rejected:exceptions", Box::new(|v| v["exceptions"] = json!([{ "code": "duplicate_claim", "count": 3 }]))),
        ("receipt_rejected:missing_evidence", Box::new(|v| v["missing_evidence"] = json!(["bank_settlements_stale_or_carried_forward"]))),
        ("receipt_rejected:checks_run", Box::new(|v| v["checks_run"] = json!(["three_way_match"]))),
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
    assert_eq!(run_with(&mut c, "DEMO-RENTAL", |_| None), "outlayer_admission_failed");
    assert_eq!(run_with(&mut c, "DEMO-RENTAL", |_| Some(b"null".to_vec())), "outlayer_run_failed");
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

/// Transfers the last call created, as (receiver, yoctoNEAR).
fn transfers() -> Vec<(String, u128)> {
    get_created_receipts()
        .iter()
        .flat_map(|r| r.actions.iter().filter_map(move |a| if let MockAction::Transfer { deposit, .. } = a { Some((r.receiver_id.to_string(), deposit.as_yoctonear())) } else { None }))
        .collect()
}
const BYTE: u128 = 10_000_000_000_000_000_000; // yoctoNEAR per byte of storage

#[test]
fn malformed_utf8_periods_and_dates_are_rejected_not_panicked_and_the_pending_run_is_cleared() {
    let mut c = setup();
    let cases: Vec<Case> = vec![
        ("receipt_rejected:period_or_as_of", Box::new(|v| v["period"] = json!("2026-1\u{e9}"))),
        ("receipt_rejected:period_or_as_of", Box::new(|v| v["period"] = json!("\u{ff12}\u{ff10}26-10"))),
        ("receipt_rejected:period_or_as_of", Box::new(|v| v["as_of"] = json!("2026-11-0\u{e9}T09:00:00Z"))),
        // a multi-byte character across byte 7 of a 10-byte date used to panic in the slice
        ("receipt_rejected:metrics_as_of", Box::new(|v| v["metrics"]["as_of"] = json!("2026-1\u{e9}-1"))),
        ("receipt_rejected:metrics_collection", Box::new(|v| v["metrics"]["collection"]["cutoff"] = json!("2026-1\u{e9}-1"))),
        ("receipt_rejected:passport", Box::new(|v| v["passport"][1]["as_of"] = json!("2026-11-0\u{e9}T06:00:00Z"))),
    ];
    for (want, edit) in cases {
        assert_eq!(run_with(&mut c, "HONEST-CREDIT", |n| Some(engine_output("HONEST-CREDIT", n, &edit))), want);
        assert!(c.get_token("HONEST-CREDIT".into()).unwrap()["pending"].is_null(), "{want}: the pending run is cleared");
    }
}

#[test]
fn json_string_receipts_and_non_objects_are_refused() {
    let mut c = setup();
    let wrapped = |n: &str| Some(json!(String::from_utf8(engine_output("HONEST-RENTAL", n, |_| {})).unwrap()).to_string().into_bytes());
    assert_eq!(run_with(&mut c, "HONEST-RENTAL", wrapped), "receipt_not_object");
    assert_eq!(run_with(&mut c, "HONEST-RENTAL", |_| Some(b"[1,2]".to_vec())), "receipt_not_object");
    assert!(c.get_latest("HONEST-RENTAL".into()).is_none());
    // a stored receipt is always the object, so the next run's input carries its passport
    assert_eq!(run_with(&mut c, "HONEST-RENTAL", |n| Some(engine_output("HONEST-RENTAL", n, |_| {}))), "stored:1");
    assert_eq!(c.get_run_input("HONEST-RENTAL".into())["previous"].as_array().unwrap().len(), 3);
}

#[test]
fn admission_failure_refunds_the_outlayer_deposit_an_admitted_failure_does_not() {
    let deposit = NearToken::from_millinear(10).as_yoctonear();
    let storage = NearToken::from_millinear(250).as_yoctonear();
    let mut c = setup();
    // refused at admission: NEAR returned the deposit to this contract, which passes it on with the storage refund
    assert_eq!(run_with(&mut c, "DEMO-CREDIT", |_| None), "outlayer_admission_failed");
    let t = transfers();
    assert_eq!(t.len(), 1);
    assert_eq!(t[0].0, "runner.testnet");
    assert!(t[0].1 > deposit && t[0].1 <= deposit + storage, "deposit back plus the unused storage: {}", t[0].1);
    // admitted, then failed (OutLayer resolves null and refunds the payer itself): only the storage refund
    assert_eq!(run_with(&mut c, "DEMO-CREDIT", |_| Some(b"null".to_vec())), "outlayer_run_failed");
    let t = transfers();
    assert_eq!(t.len(), 1);
    assert!(t[0].1 < storage, "no OutLayer deposit refunded twice: {}", t[0].1);
    // a module error is an admitted run too
    assert_eq!(run_with(&mut c, "DEMO-CREDIT", |_| Some(br#"{"error":"run_failed","method":"cashflow-v2.1.0","stage":"dues_missing"}"#.to_vec())), "module_failed:dues_missing");
    assert!(transfers().iter().all(|(_, a)| *a < storage));
}

#[test]
fn the_requester_pays_for_the_pending_record_and_everything_the_run_stores() {
    let storage = NearToken::from_millinear(250).as_yoctonear();
    let mut c = setup();
    set("runner.testnet", attach(), vec![]);
    let _ = c.request_run("DEMO-RENTAL".into());
    let p = c.get_token("DEMO-RENTAL".into()).unwrap()["pending"].clone();
    let pending_bytes = p["pending_bytes"].as_u64().unwrap() as u128;
    assert!(pending_bytes > 100, "the pending record's storage is measured: {pending_bytes}");
    let out = engine_output("DEMO-RENTAL", p["run_nonce"].as_str().unwrap(), |_| {});
    set("receipts.truenav.testnet", NearToken::from_yoctonear(0), vec![PromiseResult::Successful(out.clone())]);
    assert_eq!(c.on_run_result("DEMO-RENTAL".into(), p["request_id"].as_u64().unwrap()), "stored:1");
    let refund = transfers()[0].1;
    let charged = storage - refund;
    // at least the pending record plus the receipt bytes; the record also stores its index fields
    assert!(charged >= (pending_bytes + out.len() as u128) * BYTE, "charged {charged}");
    assert!(charged < (pending_bytes + 2 * out.len() as u128 + 1_000) * BYTE, "charged {charged}");
}

#[test]
fn the_pending_request_snapshots_the_method_as_well_as_the_build() {
    let mut c = setup();
    set("runner.testnet", attach(), vec![]);
    let _ = c.request_run("HONEST-RENTAL".into());
    let p = c.get_token("HONEST-RENTAL".into()).unwrap()["pending"].clone();
    assert_eq!(p["method"], "cashflow-v2.1.0");
    set("admin.testnet", NearToken::from_yoctonear(1), vec![]);
    let mut next = config();
    next.method = "cashflow-v2.2.0".into();
    next.version_key = "ab".repeat(32);
    c.set_config(next);
    let out = engine_output("HONEST-RENTAL", p["run_nonce"].as_str().unwrap(), |_| {});
    set("receipts.truenav.testnet", NearToken::from_yoctonear(0), vec![PromiseResult::Successful(out)]);
    assert_eq!(c.on_run_result("HONEST-RENTAL".into(), p["request_id"].as_u64().unwrap()), "stored:1");
    let r = c.get_latest("HONEST-RENTAL".into()).unwrap();
    assert_eq!((r.method.as_str(), r.version_key.as_str()), ("cashflow-v2.1.0", PIN));
}

#[test]
fn a_rental_in_severe_arrears_is_stored_red_and_replaces_the_green_receipt() {
    // HONEST-RENTAL with every rent payment removed (tests/arrears.mjs): 4 months unpaid, late_share_bps 40000
    let arrears = |n: &str| {
        let mut v = fixture("HONEST-RENTAL-ARREARS");
        v["run_nonce"] = json!(n);
        Some(v.to_string().into_bytes())
    };
    assert_eq!(fixture("HONEST-RENTAL-ARREARS")["metrics"]["late_share_bps"], 40000);
    let mut c = setup();
    assert_eq!(run_with(&mut c, "HONEST-RENTAL", |n| Some(engine_output("HONEST-RENTAL", n, |_| {}))), "stored:1");
    assert_eq!(c.get_latest("HONEST-RENTAL".into()).unwrap().band, "green");
    assert_eq!(run_with(&mut c, "HONEST-RENTAL", arrears), "stored:2");
    let r = c.get_latest("HONEST-RENTAL".into()).unwrap();
    assert_eq!((r.seq, r.score, r.band.as_str()), (2, 59, "red"));
    assert_eq!(r.caps, vec!["payout_exceeds_net_cash".to_string(), "collection_shortfall".to_string()]);
    // still an integer, and still bounded: 100 periods of rent
    let tweak = |val: Value| {
        move |n: &str| {
            let mut v = fixture("HONEST-RENTAL-ARREARS");
            v["run_nonce"] = json!(n);
            v["metrics"]["late_share_bps"] = val.clone();
            Some(v.to_string().into_bytes())
        }
    };
    assert_eq!(run_with(&mut c, "HONEST-RENTAL", tweak(json!(1_000_001))), "receipt_rejected:metrics_value");
    assert_eq!(run_with(&mut c, "HONEST-RENTAL", tweak(json!(40000.5))), "receipt_rejected:metrics_value");
    assert_eq!(run_with(&mut c, "HONEST-RENTAL", tweak(json!("40000"))), "receipt_rejected:metrics_value");
    // credit late share is a share of principal, so it stays at most 10000
    assert_eq!(run_with(&mut c, "HONEST-CREDIT", |n| Some(engine_output("HONEST-CREDIT", n, |v| v["metrics"]["late_share_bps"] = json!(10_001)))), "receipt_rejected:metrics_value");
    assert_eq!(c.get_latest("HONEST-RENTAL".into()).unwrap().seq, 2);
}

/// Request a run for a token, then the admin clears it; returns (request_id, nonce, storage refund at clear).
fn request_then_clear(c: &mut Receipts, token: &str) -> (u64, String, u128) {
    set("runner.testnet", attach(), vec![]);
    let _ = c.request_run(token.into());
    let p = c.get_token(token.into()).unwrap()["pending"].clone();
    set("admin.testnet", NearToken::from_yoctonear(1), vec![]);
    let _ = c.clear_pending(token.into());
    let t = transfers();
    assert_eq!(t.len(), 1, "clear_pending refunds the storage deposit once");
    assert_eq!(t[0].0, "runner.testnet");
    assert!(c.get_token(token.into()).unwrap()["pending"].is_null());
    (p["request_id"].as_u64().unwrap(), p["run_nonce"].as_str().unwrap().to_string(), t[0].1)
}

#[test]
fn a_failed_promise_arriving_after_clear_pending_refunds_the_outlayer_deposit_exactly_once() {
    let deposit = NearToken::from_millinear(10).as_yoctonear();
    let storage = NearToken::from_millinear(250).as_yoctonear();
    let mut c = setup();
    let (rid, _, at_clear) = request_then_clear(&mut c, "DEMO-CREDIT");
    let held = storage - at_clear;
    assert!(held > 0 && held < NearToken::from_millinear(2).as_yoctonear(), "the late record's bytes are held back: {held}");
    // the late FAILED callback: refunded the OutLayer deposit and the held bytes, to the requester
    set("receipts.truenav.testnet", NearToken::from_yoctonear(0), vec![PromiseResult::Failed]);
    assert_eq!(c.on_run_result("DEMO-CREDIT".into(), rid), "late_refunded");
    let t = transfers();
    assert_eq!(t, vec![("runner.testnet".to_string(), deposit + held)]);
    assert!(get_logs().iter().any(|l| l.contains("late_callback") && l.contains("late_refunded")));
    // the same callback again: nothing more (no double refund)
    set("receipts.truenav.testnet", NearToken::from_yoctonear(0), vec![PromiseResult::Failed]);
    assert_eq!(c.on_run_result("DEMO-CREDIT".into(), rid), "no_pending");
    assert!(transfers().is_empty());
    // storage over the whole lifecycle: the record is gone again
    assert!(c.get_latest("DEMO-CREDIT".into()).is_none());
}

#[test]
fn a_late_successful_or_null_callback_after_clear_pending_refunds_no_outlayer_deposit_and_stores_nothing() {
    let deposit = NearToken::from_millinear(10).as_yoctonear();
    let mut c = setup();
    for (i, result) in [Some(true), None].into_iter().enumerate() {
        let (rid, nonce, _) = request_then_clear(&mut c, "HONEST-CREDIT");
        let bytes = match result {
            Some(_) => engine_output("HONEST-CREDIT", &nonce, |_| {}),
            None => b"null".to_vec(),
        };
        set("receipts.truenav.testnet", NearToken::from_yoctonear(0), vec![PromiseResult::Successful(bytes)]);
        assert_eq!(c.on_run_result("HONEST-CREDIT".into(), rid), "late_ignored", "case {i}");
        let t = transfers();
        assert_eq!(t.len(), 1);
        assert!(t[0].1 < deposit, "only the held record bytes come back, not the OutLayer deposit: {}", t[0].1);
        assert!(c.get_latest("HONEST-CREDIT".into()).is_none(), "a late receipt is not stored");
    }
}

#[test]
fn a_late_callback_for_a_cleared_request_does_not_touch_the_newer_pending_request() {
    let deposit = NearToken::from_millinear(10).as_yoctonear();
    let mut c = setup();
    let (old, _, _) = request_then_clear(&mut c, "DEMO-RENTAL");
    // a new request for the same token is pending when the old FAILED callback arrives
    set("runner.testnet", attach(), vec![]);
    let _ = c.request_run("DEMO-RENTAL".into());
    let new = c.get_token("DEMO-RENTAL".into()).unwrap()["pending"]["request_id"].as_u64().unwrap();
    assert_ne!(old, new);
    set("receipts.truenav.testnet", NearToken::from_yoctonear(0), vec![PromiseResult::Failed]);
    assert_eq!(c.on_run_result("DEMO-RENTAL".into(), old), "late_refunded");
    assert!(transfers()[0].1 > deposit);
    assert_eq!(c.get_token("DEMO-RENTAL".into()).unwrap()["pending"]["request_id"].as_u64(), Some(new), "the newer request stays pending");
    // a stale callback with no late record refunds nothing
    set("receipts.truenav.testnet", NearToken::from_yoctonear(0), vec![PromiseResult::Failed]);
    assert_eq!(c.on_run_result("DEMO-RENTAL".into(), 999), "stale_callback");
    assert!(transfers().is_empty());
}
