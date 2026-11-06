// TEE underwriter verdicts on the contract, checked with REAL responses signed by the NEAR AI Cloud
// model TEE (tests/fixtures/tee-verdicts.json, produced by node tee/underwrite.mjs after attesting the
// signer with a fresh nonce). The fixture holds only the verdict-only replies, never document text.
use near_sdk::serde_json::{self, Value};
use near_sdk::test_utils::{accounts, VMContextBuilder};
use near_sdk::{testing_env, AccountId};
use truenav_registry::Registry;

const CONTRACT: &str = "registry.test.near";
const NOW: u64 = 1_762_776_000_000;

fn ctx(predecessor: &AccountId, now_ms: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(CONTRACT.parse().unwrap())
        .predecessor_account_id(predecessor.clone())
        .block_timestamp(now_ms * 1_000_000)
        .attached_deposit(near_sdk::NearToken::from_yoctonear(1));
    testing_env!(b.build());
}

fn fixture() -> Value {
    serde_json::from_str(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/tee-verdicts.json")).unwrap()).unwrap()
}

fn s(v: &Value, k: &str) -> String {
    v[k].as_str().unwrap().to_string()
}

fn setup(register: bool) -> (Registry, Value) {
    let fx = fixture();
    ctx(&accounts(0), NOW);
    let mut r = Registry::new(accounts(0), accounts(1));
    if register {
        r.add_tee_signer(s(&fx, "signer"), s(&fx, "model"), format!("attested with nonce {}", s(&fx, "attestation_nonce")));
    }
    (r, fx)
}

fn submit(r: &mut Registry, rec: &Value) -> truenav_registry::StoredVerdict {
    r.submit_verdict(s(rec, "loan_hash"), s(rec, "model_id"), s(rec, "request_sha256"), s(rec, "response_body"), s(rec, "signature"))
}

fn record<'a>(fx: &'a Value, id: &str) -> &'a Value {
    fx["records"].as_array().unwrap().iter().find(|r| r["loan_id"] == id || r["tampered"] == id).unwrap()
}

#[test]
fn every_real_tee_verdict_verifies_and_matches() {
    let (mut r, fx) = setup(true);
    let recs = fx["records"].as_array().unwrap().clone();
    assert_eq!(recs.len(), 19);
    for (i, rec) in recs.iter().enumerate() {
        ctx(&accounts(5), NOW + i as u64);
        let v = submit(&mut r, rec);
        assert_eq!(v.verdict, s(rec, "expected_verdict"), "{}", s(rec, "loan_id"));
        assert_eq!(v.signer, s(&fx, "signer"));
        let want: Vec<String> = rec["expected_anomalies"].as_array().unwrap().iter().map(|a| a.as_str().unwrap().to_string()).collect();
        assert_eq!(v.anomalies, want);
    }
    let flags = recs.iter().filter(|rec| rec["expected_verdict"] == "flag").count();
    assert_eq!(flags, 3, "the three tampered documents are flagged");
}

#[test]
fn honest_document_passes_and_tampered_amount_is_flagged() {
    let (mut r, fx) = setup(true);
    let honest = record(&fx, "H-RE-01");
    assert_eq!(submit(&mut r, honest).verdict, "pass");
    let t1 = record(&fx, "T1-altered-amount");
    let v = submit(&mut r, t1);
    assert_eq!(v.verdict, "flag");
    assert!(v.anomalies.contains(&"amount_mismatch".to_string()));
}

#[test]
fn latest_verdict_counts_and_history_keeps_the_flag() {
    // T1 is the tampered copy of H-RE-01's document, checked against H-RE-01's claim: same loan_hash.
    let (mut r, fx) = setup(true);
    let t1 = record(&fx, "T1-altered-amount");
    let honest = record(&fx, "H-RE-01");
    assert_eq!(s(t1, "loan_hash"), s(honest, "loan_hash"));
    submit(&mut r, t1);
    ctx(&accounts(5), NOW + 5);
    submit(&mut r, honest);
    let lh = s(honest, "loan_hash");
    assert_eq!(r.get_latest_verdict(lh.clone()).unwrap().verdict, "pass");
    assert_eq!(r.get_verdict_count(lh.clone()), 2);
    assert_eq!(r.get_flag_count(lh.clone()), 1);
    assert_eq!(r.get_verdicts_page(lh, 0, 10)[0].verdict, "flag");
}

#[test]
#[should_panic(expected = "this signed response was already submitted")]
fn the_same_signed_verdict_is_accepted_once() {
    let (mut r, fx) = setup(true);
    let rec = record(&fx, "H-RE-02");
    submit(&mut r, rec);
    submit(&mut r, rec);
}

#[test]
#[should_panic(expected = "TEE signer not registered")]
fn edited_response_fails_the_tee_signature() {
    let (mut r, fx) = setup(true);
    let mut rec = record(&fx, "T1-altered-amount").clone();
    // Turn the flag into a pass: the response hash changes, so the recovered signer is someone else.
    let body = s(&rec, "response_body").replace("\\\"verdict\\\":\\\"flag\\\"", "\\\"verdict\\\":\\\"pass\\\"").replace("\\\"anomalies\\\":[\\\"asset_mismatch\\\",\\\"amount_mismatch\\\"]", "\\\"anomalies\\\":[]");
    assert_ne!(body, s(&rec, "response_body"));
    rec["response_body"] = Value::String(body);
    submit(&mut r, &rec);
}

#[test]
#[should_panic(expected = "TEE signer not registered")]
fn unregistered_tee_signer_is_refused() {
    let (mut r, fx) = setup(false);
    submit(&mut r, record(&fx, "H-RE-03"));
}

#[test]
#[should_panic(expected = "verdict is for another loan_hash")]
fn verdict_cannot_be_moved_to_another_loan() {
    let (mut r, fx) = setup(true);
    let mut rec = record(&fx, "H-RE-04").clone();
    rec["loan_hash"] = record(&fx, "H-RE-05")["loan_hash"].clone();
    submit(&mut r, &rec);
}

#[test]
#[should_panic(expected = "TEE signer not registered")]
fn wrong_model_id_breaks_the_signed_text() {
    let (mut r, fx) = setup(true);
    let mut rec = record(&fx, "H-RE-06").clone();
    rec["model_id"] = Value::String("Some/Other-Model".into());
    submit(&mut r, &rec);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn only_a_full_access_admin_call_registers_a_tee_signer() {
    let fx = fixture();
    ctx(&accounts(0), NOW);
    let mut r = Registry::new(accounts(0), accounts(1));
    let mut b = VMContextBuilder::new();
    b.current_account_id(CONTRACT.parse().unwrap()).predecessor_account_id(accounts(0)).block_timestamp(NOW * 1_000_000);
    testing_env!(b.build());
    r.add_tee_signer(s(&fx, "signer"), s(&fx, "model"), "x".into());
}
