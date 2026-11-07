// TEE underwriter verdicts on the contract, checked with REAL responses signed by the NEAR AI Cloud model TEE
// and bound to registry.test.near (tests/fixtures/tee-verdicts.json, from node tee/underwrite.mjs after attesting
// the signer with a fresh nonce). The fixture holds only the verdict-only replies, never document text.
// Owner decisions of 6 Nov: only the servicer submits; the loan must be pledged; the binding must name this
// contract, network, version and an unexpired time; a flag clears only with a later pass from a new request.
use k256::ecdsa::SigningKey;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::test_utils::{accounts, VMContextBuilder};
use near_sdk::{testing_env, AccountId};
use truenav_registry::{eip191_digest, Registry, VERDICT_DOMAIN};

const CONTRACT: &str = "registry.test.near";

fn ctx_at(predecessor: &AccountId, now_ms: u64, yocto: u128) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(CONTRACT.parse().unwrap())
        .predecessor_account_id(predecessor.clone())
        .block_timestamp(now_ms * 1_000_000)
        .attached_deposit(near_sdk::NearToken::from_yoctonear(yocto));
    testing_env!(b.build());
}

fn fixture() -> Value {
    serde_json::from_str(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/tee-verdicts.json")).unwrap()).unwrap()
}
fn s(v: &Value, k: &str) -> String {
    v[k].as_str().unwrap().to_string()
}
fn admin() -> AccountId { accounts(0) }
fn servicer() -> AccountId { accounts(1) }
fn harbor() -> AccountId { accounts(2) }
fn meridian() -> AccountId { accounts(3) }
fn fund_acct(fund_id: &str) -> AccountId {
    if fund_id == "harbor-credit-fund" { harbor() } else { meridian() }
}
/// Block time just after the fixture was signed, so its 30-day binding is valid.
fn now(fx: &Value) -> u64 {
    fx["signed_at_ms"].as_u64().unwrap() + 60_000
}

/// Registry with both funds, the real TEE signer registered by the registrar, and every fixture loan pledged by
/// its fund (T3's H-RE-09 included, pledged by Harbor).
fn setup(register_tee: bool) -> (Registry, Value) {
    let fx = fixture();
    let t = now(&fx);
    ctx_at(&admin(), t, 1);
    let mut r = Registry::new(admin(), servicer());
    r.register_fund("harbor-credit-fund".into(), harbor(), "manager-harbor".into());
    r.register_fund("meridian-yield-fund".into(), meridian(), "manager-meridian".into());
    if register_tee {
        r.add_tee_signer(s(&fx, "signer"), s(&fx, "model"), format!("attested with nonce {}", s(&fx, "attestation_nonce")), s(&fx, "attestation_sha256"));
    }
    let mut seen = std::collections::HashSet::new();
    for rec in fx["records"].as_array().unwrap() {
        let h = s(rec, "loan_hash");
        if seen.insert(h.clone()) {
            ctx_at(&fund_acct(&s(rec, "fund_id")), t, 1);
            r.pledge_loan(h, rec["asset_type"].as_str().unwrap_or("real_estate").to_string());
        }
    }
    (r, fx)
}

fn submit(r: &mut Registry, rec: &Value) -> truenav_registry::StoredVerdict {
    r.submit_verdict(s(rec, "loan_hash"), s(rec, "model_id"), s(rec, "request_sha256"), s(rec, "response_body"), s(rec, "signature"))
}
fn record<'a>(fx: &'a Value, id: &str) -> &'a Value {
    fx["records"].as_array().unwrap().iter().find(|r| r["loan_id"] == id && r["tampered"].is_null() || r["tampered"] == id).unwrap()
}

#[test]
fn every_real_tee_verdict_verifies_and_matches() {
    let (mut r, fx) = setup(true);
    let recs = fx["records"].as_array().unwrap().clone();
    assert_eq!(recs.len(), 19);
    for (i, rec) in recs.iter().enumerate() {
        ctx_at(&servicer(), now(&fx) + 1 + i as u64, 1);
        let v = submit(&mut r, rec);
        assert_eq!(v.verdict, s(rec, "expected_verdict"), "{}", s(rec, "loan_id"));
        assert_eq!(v.signer, s(&fx, "signer"));
        assert_eq!(v.attestation_sha256, s(&fx, "attestation_sha256"));
        assert_eq!(v.submitted_by, servicer());
        let want: Vec<String> = rec["expected_anomalies"].as_array().unwrap().iter().map(|a| a.as_str().unwrap().to_string()).collect();
        assert_eq!(v.anomalies, want);
    }
}

// 6a: a rival (or the fund itself, or the admin) with a genuine TEE flag on Harbor's loan is refused; only the
// servicer submits.
fn submit_as(who: AccountId) {
    let (mut r, fx) = setup(true);
    ctx_at(&who, now(&fx), 1);
    submit(&mut r, record(&fx, "T1-altered-amount"));
}
#[test]
#[should_panic(expected = "servicer only")]
fn a_rival_fund_cannot_submit_a_verdict() { submit_as(meridian()); }
#[test]
#[should_panic(expected = "servicer only")]
fn the_owning_fund_cannot_submit_its_own_verdict() { submit_as(harbor()); }
#[test]
#[should_panic(expected = "servicer only")]
fn the_admin_cannot_submit_a_verdict() { submit_as(admin()); }
#[test]
#[should_panic(expected = "servicer only")]
fn a_stranger_cannot_submit_a_verdict() { submit_as(accounts(5)); }

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn servicer_verdict_needs_one_yocto() {
    let (mut r, fx) = setup(true);
    ctx_at(&servicer(), now(&fx), 0);
    submit(&mut r, record(&fx, "H-RE-02"));
}

#[test]
#[should_panic(expected = "loan not pledged")]
fn verdict_on_an_unpledged_loan_is_refused() {
    let (mut r, fx) = setup(true);
    ctx_at(&servicer(), now(&fx) + 1, 1);
    r.release_loan(s(record(&fx, "H-RE-03"), "loan_hash"));
    ctx_at(&servicer(), now(&fx) + 2, 1);
    submit(&mut r, record(&fx, "H-RE-03"));
}

#[test]
fn verdict_counts_only_for_the_current_pledge() {
    // C2: after release and re-pledge, the old verdict no longer counts; history stays.
    let (mut r, fx) = setup(true);
    let rec = record(&fx, "H-RE-04");
    let h = s(rec, "loan_hash");
    ctx_at(&servicer(), now(&fx) + 1, 1);
    submit(&mut r, rec);
    assert!(r.get_latest_verdict(h.clone()).is_some());
    ctx_at(&servicer(), now(&fx) + 2, 1);
    r.release_loan(h.clone());
    assert!(r.get_latest_verdict(h.clone()).is_none(), "no pledge, no counting verdict");
    ctx_at(&meridian(), now(&fx) + 3, 1);
    r.pledge_loan(h.clone(), "real_estate".into());
    assert!(r.get_latest_verdict(h.clone()).is_none(), "the new pledge starts without a verdict");
    assert_eq!(r.get_verdict_count(h), 1, "history kept");
}

#[test]
fn a_flag_clears_with_a_later_servicer_pass_from_a_new_request() {
    // T1 (tampered copy of H-RE-01's document) flags H-RE-01's loan; the honest document's pass is a new request.
    let (mut r, fx) = setup(true);
    let t1 = record(&fx, "T1-altered-amount");
    let honest = record(&fx, "H-RE-01");
    assert_eq!(s(t1, "loan_hash"), s(honest, "loan_hash"));
    ctx_at(&servicer(), now(&fx) + 1, 1);
    submit(&mut r, t1);
    let lh = s(honest, "loan_hash");
    assert_eq!(r.get_latest_verdict(lh.clone()).unwrap().verdict, "flag");
    ctx_at(&servicer(), now(&fx) + 5, 1);
    submit(&mut r, honest);
    assert_eq!(r.get_latest_verdict(lh.clone()).unwrap().verdict, "pass");
    assert_eq!(r.get_flag_count(lh.clone()), 1);
    assert_eq!(r.get_verdicts_page(lh, 0, 10)[0].verdict, "flag");
}

// ---------- synthetic TEE key (test only) to reach rules real data cannot ----------

fn test_tee() -> (SigningKey, String) {
    let k = SigningKey::from_bytes(&[9u8; 32].into()).unwrap();
    let p = k.verifying_key().to_encoded_point(false);
    let h = near_sdk::env::keccak256_array(&p.as_bytes()[1..]);
    (k, format!("0x{}", hex::encode(&h[12..])))
}
/// A verdict-only chat reply in the gateway's shape, signed like the TEE signs it.
#[allow(clippy::too_many_arguments)]
fn synthetic(key: &SigningKey, model: &str, loan_hash: &str, req: &str, verdict: &str, anomalies: &[&str], binding: &str, salt: &str) -> (String, String) {
    let grouped: Vec<String> = loan_hash.as_bytes().chunks(8).map(|c| String::from_utf8(c.to_vec()).unwrap()).collect();
    let content = json!({"loan_hash": grouped.join(" "), "binding": binding, "verdict": verdict, "anomalies": anomalies}).to_string();
    let body = json!({"id": format!("chatcmpl-test-{salt}"), "choices": [{"index": 0, "message": {"role": "assistant", "content": content}}]}).to_string();
    let resp = hex::encode(near_sdk::env::sha256_array(body.as_bytes()));
    let digest = eip191_digest(&format!("{model}:{req}:{resp}"));
    let (sig, rec) = key.sign_prehash_recoverable(&digest).unwrap();
    let mut out = sig.to_bytes().to_vec();
    out.push(rec.to_byte() + 27);
    (body, format!("0x{}", hex::encode(out)))
}

fn synthetic_setup() -> (Registry, SigningKey, String, u64) {
    let (key, addr) = test_tee();
    let t = 1_793_000_000_000u64;
    ctx_at(&admin(), t, 1);
    let mut r = Registry::new(admin(), servicer());
    r.register_fund("harbor-credit-fund".into(), harbor(), "manager-harbor".into());
    r.add_tee_signer(addr, "Test/Model".into(), "test key".into(), "a".repeat(64));
    ctx_at(&harbor(), t, 1);
    r.pledge_loan("b".repeat(64), "real_estate".into());
    (r, key, "b".repeat(64), t)
}
fn binding(t: u64, contract: &str, network: &str, version: &str) -> String {
    format!("{version}|{contract}|{network}|{}", t + 10 * 86_400_000)
}

#[test]
#[should_panic(expected = "a flag clears only with a pass from a new request")]
fn a_pass_from_the_same_request_as_the_flag_is_refused() {
    let (mut r, key, lh, t) = synthetic_setup();
    let req = "c".repeat(64);
    let b = binding(t, CONTRACT, "mainnet", VERDICT_DOMAIN);
    let (body, sig) = synthetic(&key, "Test/Model", &lh, &req, "flag", &["amount_mismatch"], &b, "1");
    ctx_at(&servicer(), t + 1, 1);
    r.submit_verdict(lh.clone(), "Test/Model".into(), req.clone(), body, sig);
    let (body, sig) = synthetic(&key, "Test/Model", &lh, &req, "pass", &[], &b, "2");
    ctx_at(&servicer(), t + 2, 1);
    r.submit_verdict(lh, "Test/Model".into(), req, body, sig);
}

fn submit_binding(contract: &str, network: &str, version: &str, expiry_shift: i64) {
    let (mut r, key, lh, t) = synthetic_setup();
    let exp = (t as i64 + expiry_shift) as u64;
    let b = format!("{version}|{contract}|{network}|{exp}");
    let (body, sig) = synthetic(&key, "Test/Model", &lh, &"d".repeat(64), "pass", &[], &b, "x");
    ctx_at(&servicer(), t + 1, 1);
    r.submit_verdict(lh, "Test/Model".into(), "d".repeat(64), body, sig);
}
// registry.test.near ends in .near, so its network is "mainnet".
#[test]
fn a_correct_binding_is_accepted() { submit_binding(CONTRACT, "mainnet", VERDICT_DOMAIN, 86_400_000); }
#[test]
#[should_panic(expected = "verdict is bound to another contract")]
fn binding_for_another_contract_is_refused() { submit_binding("registry.other.near", "mainnet", VERDICT_DOMAIN, 86_400_000); }
#[test]
#[should_panic(expected = "verdict is bound to another network")]
fn binding_for_another_network_is_refused() { submit_binding(CONTRACT, "testnet", VERDICT_DOMAIN, 86_400_000); }
#[test]
#[should_panic(expected = "verdict binding has an unknown version")]
fn binding_with_an_unknown_version_is_refused() { submit_binding(CONTRACT, "mainnet", "truenav-verdict-v0", 86_400_000); }
#[test]
#[should_panic(expected = "verdict expired")]
fn an_expired_verdict_is_refused() { submit_binding(CONTRACT, "mainnet", VERDICT_DOMAIN, -1); }
#[test]
#[should_panic(expected = "verdict validity longer than 30 days")]
fn a_verdict_valid_for_too_long_is_refused() { submit_binding(CONTRACT, "mainnet", VERDICT_DOMAIN, 40 * 86_400_000); }

#[test]
#[should_panic(expected = "this signed response was already submitted")]
fn the_same_signed_verdict_is_accepted_once() {
    let (mut r, fx) = setup(true);
    let rec = record(&fx, "H-RE-02");
    ctx_at(&servicer(), now(&fx) + 1, 1);
    submit(&mut r, rec);
    ctx_at(&servicer(), now(&fx) + 2, 1);
    submit(&mut r, rec);
}

#[test]
#[should_panic(expected = "TEE signer not registered")]
fn edited_response_fails_the_tee_signature() {
    let (mut r, fx) = setup(true);
    let mut rec = record(&fx, "T1-altered-amount").clone();
    let body = s(&rec, "response_body").replace("\\\"verdict\\\":\\\"flag\\\"", "\\\"verdict\\\":\\\"pass\\\"");
    assert_ne!(body, s(&rec, "response_body"));
    rec["response_body"] = Value::String(body);
    ctx_at(&servicer(), now(&fx) + 1, 1);
    submit(&mut r, &rec);
}

#[test]
#[should_panic(expected = "TEE signer not registered")]
fn unregistered_tee_signer_is_refused() {
    let (mut r, fx) = setup(false);
    ctx_at(&servicer(), now(&fx) + 1, 1);
    submit(&mut r, record(&fx, "H-RE-03"));
}

#[test]
#[should_panic(expected = "verdict is for another loan_hash")]
fn verdict_cannot_be_moved_to_another_loan() {
    let (mut r, fx) = setup(true);
    let mut rec = record(&fx, "H-RE-04").clone();
    rec["loan_hash"] = record(&fx, "H-RE-05")["loan_hash"].clone();
    ctx_at(&servicer(), now(&fx) + 1, 1);
    submit(&mut r, &rec);
}

#[test]
#[should_panic(expected = "TEE signer not registered")]
fn wrong_model_id_breaks_the_signed_text() {
    let (mut r, fx) = setup(true);
    let mut rec = record(&fx, "H-RE-06").clone();
    rec["model_id"] = Value::String("Some/Other-Model".into());
    ctx_at(&servicer(), now(&fx) + 1, 1);
    submit(&mut r, &rec);
}

// ---------- reply rule (owner decision 7 Nov): only the allowed keys reach public transaction data ----------

/// Like `synthetic`, but with any reply object and extra message fields, to reach the reply rule.
fn synthetic_reply(key: &SigningKey, req: &str, reply: Value, message_extra: Value, salt: &str) -> (String, String) {
    let mut message = json!({"role": "assistant", "content": reply.to_string()});
    if let (Some(m), Some(extra)) = (message.as_object_mut(), message_extra.as_object()) {
        for (k, v) in extra { m.insert(k.clone(), v.clone()); }
    }
    let body = json!({"id": format!("chatcmpl-reply-{salt}"), "choices": [{"index": 0, "message": message}]}).to_string();
    let resp = hex::encode(near_sdk::env::sha256_array(body.as_bytes()));
    let digest = eip191_digest(&format!("Test/Model:{req}:{resp}"));
    let (sig, rec) = key.sign_prehash_recoverable(&digest).unwrap();
    let mut out = sig.to_bytes().to_vec();
    out.push(rec.to_byte() + 27);
    (body, format!("0x{}", hex::encode(out)))
}
fn clean_reply(lh: &str, b: &str) -> Value {
    let grouped: Vec<String> = lh.as_bytes().chunks(8).map(|c| String::from_utf8(c.to_vec()).unwrap()).collect();
    json!({"loan_hash": grouped.join(" "), "binding": b, "id_mismatch": "ok", "asset_mismatch": "ok", "amount_mismatch": "ok",
           "duplicate_document": "ok", "duplicate_evidence_line": "ok", "injection_attempt": "ok", "unreadable": "ok",
           "verdict": "pass", "anomalies": []})
}
fn submit_reply(edit: impl Fn(&mut Value), message_extra: Value) -> truenav_registry::StoredVerdict {
    let (mut r, key, lh, t) = synthetic_setup();
    let b = binding(t, CONTRACT, "mainnet", VERDICT_DOMAIN);
    let mut reply = clean_reply(&lh, &b);
    edit(&mut reply);
    let req = "e".repeat(64);
    let (body, sig) = synthetic_reply(&key, &req, reply, message_extra, "r");
    ctx_at(&servicer(), t + 1, 1);
    r.submit_verdict(lh, "Test/Model".into(), req, body, sig)
}

#[test]
fn a_reply_with_exactly_the_allowed_keys_is_accepted() {
    assert_eq!(submit_reply(|_| {}, json!({})).verdict, "pass");
}

#[test]
fn a_duplicate_flag_with_a_line_number_is_accepted_as_a_flag() {
    let v = submit_reply(|r| {
        r["duplicate_document"] = json!("fail");
        r["duplicate_evidence_line"] = json!(12);
        r["verdict"] = json!("flag");
        r["anomalies"] = json!(["duplicate_document"]);
    }, json!({}));
    assert_eq!((v.verdict.as_str(), v.anomalies.clone()), ("flag", vec!["duplicate_document".to_string()]));
}

#[test]
fn empty_provider_fields_beside_content_are_accepted() {
    assert_eq!(submit_reply(|_| {}, json!({"reasoning_content": null, "tool_calls": null})).verdict, "pass");
}

#[test]
#[should_panic(expected = "reply has a key outside the allowed list")]
fn a_reply_echoing_the_document_id_is_refused() {
    submit_reply(|r| { r["document_id"] = json!("TITLE-DEMO-HRE01"); }, json!({}));
}

#[test]
#[should_panic(expected = "reply has a key outside the allowed list")]
fn a_reply_echoing_the_amount_is_refused() {
    submit_reply(|r| { r["amount"] = json!("USD 1,250,000.00"); }, json!({}));
}

#[test]
#[should_panic(expected = "a check must be ok or fail")]
fn free_text_in_a_check_is_refused() {
    submit_reply(|r| { r["amount_mismatch"] = json!("fail: document shows USD 2,250,000.00"); }, json!({}));
}

#[test]
#[should_panic(expected = "duplicate_evidence_line must be a line number or ok")]
fn a_quoted_evidence_line_is_refused() {
    submit_reply(|r| { r["duplicate_evidence_line"] = json!("Stamp: CERTIFIED COPY of TITLE-1"); }, json!({}));
}

#[test]
#[should_panic(expected = "anomalies must be known codes")]
fn text_in_the_anomaly_list_is_refused() {
    submit_reply(|r| { r["anomalies"] = json!(["Borrower: Demo LLC"]); r["verdict"] = json!("flag"); }, json!({}));
}

#[test]
#[should_panic(expected = "message has a non-empty field beside role and content")]
fn a_filled_reasoning_field_is_refused() {
    submit_reply(|_| {}, json!({"reasoning_content": "the document shows USD 1,250,000.00"}));
}

#[test]
#[should_panic(expected = "reply has a key outside the allowed list")]
fn a_real_tee_signed_reply_from_6_nov_that_echoed_document_fields_is_refused() {
    // A genuine NEAR AI Cloud TEE reply (signature valid) that added document_id, asset and amount.
    let fx: Value = serde_json::from_str(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/tee-leaky-reply.json")).unwrap()).unwrap();
    let rec = &fx["record"];
    let t = fx["signed_at_ms"].as_u64().unwrap() + 60_000;
    ctx_at(&admin(), t, 1);
    let mut r = Registry::new(admin(), servicer());
    r.register_fund(s(rec, "fund_id"), fund_acct(&s(rec, "fund_id")), "manager".into());
    r.add_tee_signer(s(&fx, "signer"), s(&fx, "model"), "attested".into(), s(&fx, "attestation_sha256"));
    ctx_at(&fund_acct(&s(rec, "fund_id")), t, 1);
    r.pledge_loan(s(rec, "loan_hash"), s(rec, "asset_type"));
    ctx_at(&servicer(), t + 1, 1);
    r.submit_verdict(s(rec, "loan_hash"), s(rec, "model_id"), s(rec, "request_sha256"), s(rec, "response_body"), s(rec, "signature"));
}
