// Unit tests for the TrueNav test registry. Run with `cargo test` in contract/.
// The test signer is a fixed throwaway secp256k1 key used only inside these tests. It holds no value
// and is not a NEAR account key.
use k256::ecdsa::SigningKey;
use near_sdk::test_utils::{accounts, VMContextBuilder};
use near_sdk::{testing_env, AccountId};
use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
use truenav_registry::{canonical_message, eip191_digest, Certificate, PledgeOutcome, Registry};

#[path = "pledge_help.rs"]
mod pledge_help;

fn next_nonce() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(1);
    format!("{:064x}", N.fetch_add(1, Ordering::Relaxed))
}

fn pledge_as(r: &mut Registry, caller: &AccountId, fund: &AccountId, loan: &str, asset: &str, when: u64) -> PledgeOutcome {
    pledge_as_nonce(r, caller, fund, loan, asset, &next_nonce(), when, when + 60_000, None)
}

fn pledge_as_nonce(
    r: &mut Registry,
    caller: &AccountId,
    fund: &AccountId,
    loan: &str,
    asset: &str,
    nonce: &str,
    when: u64,
    expiry: u64,
    ticket: Option<String>,
) -> PledgeOutcome {
    ctx(caller, when);
    let sig = pledge_help::sign_pledge(&pledge_help::servicer_key(), CONTRACT, fund.as_str(), loan, asset, nonce, expiry);
    r.pledge_loan(loan.into(), asset.into(), fund.clone(), nonce.into(), expiry, sig, ticket)
}

const CONTRACT: &str = "registry.test.near";

/// Every test call carries 1 yoctoNEAR, as the admin, servicer and pledge methods require it (full-access key).
/// Unit tests call methods directly, so the deposit does not trip non-payable methods here.
fn ctx(predecessor: &AccountId, now_ms: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(CONTRACT.parse().unwrap())
        .predecessor_account_id(predecessor.clone())
        .block_timestamp(now_ms * 1_000_000)
        .attached_deposit(near_sdk::NearToken::from_yoctonear(1));
    testing_env!(b.build());
}

fn test_key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32].into()).unwrap()
}

fn address_of(key: &SigningKey) -> String {
    let point = key.verifying_key().to_encoded_point(false);
    let h = near_sdk::env::keccak256_array(&point.as_bytes()[1..]);
    format!("0x{}", hex::encode(&h[12..]))
}

fn sign(key: &SigningKey, cert: &Certificate) -> String {
    let digest = eip191_digest(&canonical_message(CONTRACT, cert));
    let (sig, rec) = key.sign_prehash_recoverable(&digest).unwrap();
    let mut out = sig.to_bytes().to_vec();
    out.push(rec.to_byte() + 27);
    format!("0x{}", hex::encode(out))
}

const NOW: u64 = 1_762_776_000_000; // 2026-11-10T12:00:00Z

fn admin() -> AccountId { accounts(0) }
fn servicer() -> AccountId { accounts(1) }
fn harbor_acct() -> AccountId { accounts(2) }
fn meridian_acct() -> AccountId { accounts(3) }

fn setup() -> (Registry, SigningKey) {
    ctx(&admin(), NOW);
    let mut r = Registry::new(admin(), servicer());
    let key = test_key(7);
    r.add_signer(address_of(&key));
    r.set_servicer_pledge_key(pledge_help::address_of(&pledge_help::servicer_key()));
    r.register_fund("harbor-credit-fund".into(), harbor_acct(), "manager-harbor".into());
    r.register_fund("meridian-yield-fund".into(), meridian_acct(), "manager-meridian".into());
    (r, key)
}

fn harbor_cert(signed_at: u64) -> Certificate {
    Certificate {
        fund_id: "harbor-credit-fund".into(),
        fund_account: harbor_acct(),
        manager_id: "manager-harbor".into(),
        status: "scored".into(),
        score: Some(99),
        band: "green".into(),
        raw_x100: 9917,
        true_val_cents: near_sdk::json_types::U128(966_511_000),
        true_range_cents: near_sdk::json_types::U128(34_555_400),
        policy_nav_cents: near_sdk::json_types::U128(950_000_000),
        headline_cents: near_sdk::json_types::U128(950_000_000),
        blocked_attempts: 0,
        data_asof_ms: signed_at - 30 * 3_600_000,
        signed_at_ms: signed_at,
        engine_commit: "bc84b01".into(),
    }
}

const LOAN: &str = "1111111111111111111111111111111111111111111111111111111111111111";

#[test]
fn certificate_with_registered_signer_is_stored_and_readable() {
    let (mut r, key) = setup();
    let c = harbor_cert(NOW);
    let stored = r.submit_certificate(c.clone(), sign(&key, &c));
    assert_eq!(stored.signer, address_of(&key));
    assert_eq!(r.get_latest_certificate("harbor-credit-fund".into()).unwrap().certificate, c);
    assert_eq!(r.get_certificate_history_page("harbor-credit-fund".into(), 0, 100), vec![NOW]);
}

#[test]
#[should_panic(expected = "signer not registered")]
fn certificate_from_unregistered_signer_is_rejected() {
    let (mut r, _) = setup();
    let c = harbor_cert(NOW);
    let other = test_key(9);
    r.submit_certificate(c.clone(), sign(&other, &c));
}

#[test]
#[should_panic(expected = "signer not registered")]
fn tampered_certificate_fails_the_signature_check() {
    let (mut r, key) = setup();
    let c = harbor_cert(NOW);
    let sig = sign(&key, &c);
    let mut bad = c;
    bad.raw_x100 = 10000; // changed after signing: recovers a different address
    r.submit_certificate(bad, sig);
}

#[test]
#[should_panic(expected = "fund_id not registered")]
fn renamed_fund_id_is_rejected_hole_5() {
    let (mut r, key) = setup();
    let mut c = harbor_cert(NOW);
    c.fund_id = "harbor-credit-fund-new".into();
    r.submit_certificate(c.clone(), sign(&key, &c));
}

#[test]
#[should_panic(expected = "fund_account does not match the registered fund")]
fn certificate_for_another_funds_account_is_rejected() {
    let (mut r, key) = setup();
    let mut c = harbor_cert(NOW);
    c.fund_account = meridian_acct();
    r.submit_certificate(c.clone(), sign(&key, &c));
}

#[test]
#[should_panic(expected = "manager_id does not match the registered fund")]
fn certificate_with_a_different_manager_is_rejected() {
    let (mut r, key) = setup();
    let mut c = harbor_cert(NOW);
    c.manager_id = "manager-other".into();
    r.submit_certificate(c.clone(), sign(&key, &c));
}

#[test]
#[should_panic(expected = "signed_at must be newer than the last certificate")]
fn replayed_or_older_certificate_is_rejected() {
    let (mut r, key) = setup();
    let c = harbor_cert(NOW);
    r.submit_certificate(c.clone(), sign(&key, &c));
    r.submit_certificate(c.clone(), sign(&key, &c));
}

#[test]
fn rotated_signer_works_and_removed_signer_does_not() {
    let (mut r, key) = setup();
    let new_key = test_key(8);
    r.add_signer(address_of(&new_key));
    r.remove_signer(address_of(&key));
    let c = harbor_cert(NOW);
    r.submit_certificate(c.clone(), sign(&new_key, &c));
    assert_eq!(r.get_signers(), vec![address_of(&new_key)]);
}

#[test]
#[should_panic(expected = "registrar only")]
fn only_the_registrar_adds_signers() {
    let (mut r, _) = setup();
    ctx(&harbor_acct(), NOW);
    r.add_signer(address_of(&test_key(3)));
}

#[test]
#[should_panic(expected = "a scored status needs a score")]
fn scored_status_without_score_is_rejected() {
    let (mut r, key) = setup();
    let mut c = harbor_cert(NOW);
    c.score = None;
    c.band = String::new();
    r.submit_certificate(c.clone(), sign(&key, &c));
}

#[test]
fn disclaimed_certificate_without_number_is_stored() {
    let (mut r, key) = setup();
    let mut c = harbor_cert(NOW);
    c.status = "disclaimed".into();
    c.score = None;
    c.band = String::new();
    r.submit_certificate(c.clone(), sign(&key, &c));
    assert_eq!(r.get_latest_certificate("harbor-credit-fund".into()).unwrap().certificate.status, "disclaimed");
}

#[test]
fn first_pledge_mints_a_nep171_token_to_the_fund() {
    let (mut r, _) = setup();
    let out = pledge_as(&mut r, &harbor_acct(), &harbor_acct(), LOAN, "real_estate", NOW);
    assert_eq!(out, PledgeOutcome::Pledged { token_id: LOAN.into() });
    let token = r.nft_token(LOAN.into()).unwrap();
    assert_eq!(token.owner_id, harbor_acct());
    assert_eq!(r.get_lock(LOAN.into()).unwrap().fund_id, "harbor-credit-fund");
    assert_eq!(r.nft_supply_for_owner(harbor_acct()).0, 1);
}

#[test]
fn second_fund_is_refused_and_the_holder_is_not_counted_or_alerted() {
    let (mut r, _) = setup();
    pledge_as(&mut r, &harbor_acct(), &harbor_acct(), LOAN, "real_estate", NOW);
    let out = pledge_as(&mut r, &meridian_acct(), &meridian_acct(), LOAN, "real_estate", NOW + 1000);
    match out {
        PledgeOutcome::Refused { message, .. } => assert_eq!(message, "already pledged elsewhere"),
        other => panic!("expected refusal, got {other:?}"),
    }
    assert_eq!(r.get_attempts_page("meridian-yield-fund".into(), 0, 100).count, 1);
    assert_eq!(r.get_attempts_page("harbor-credit-fund".into(), 0, 100).count, 0);
    assert_eq!(r.get_alerts_page("harbor-credit-fund".into(), 0, 100), Vec::<u64>::new());
    assert_eq!(r.get_alert_count("harbor-credit-fund".into()), 0);
    assert_eq!(r.get_alert_count("meridian-yield-fund".into()), 1);
    // Token still with Harbor.
    assert_eq!(r.nft_token(LOAN.into()).unwrap().owner_id, harbor_acct());
}

#[test]
fn same_fund_pledging_again_is_not_an_attempt() {
    let (mut r, _) = setup();
    pledge_as(&mut r, &harbor_acct(), &harbor_acct(), LOAN, "real_estate", NOW);
    let out = pledge_as(&mut r, &harbor_acct(), &harbor_acct(), LOAN, "real_estate", NOW);
    assert_eq!(out, PledgeOutcome::AlreadyYours { token_id: LOAN.into() });
    assert_eq!(r.get_attempts_page("harbor-credit-fund".into(), 0, 100).count, 0);
}

#[test]
fn servicer_release_burns_the_token_and_frees_the_loan() {
    let (mut r, _) = setup();
    pledge_as(&mut r, &harbor_acct(), &harbor_acct(), LOAN, "invoices", NOW);
    ctx(&servicer(), NOW + 5);
    r.release_loan(LOAN.into());
    assert!(r.nft_token(LOAN.into()).is_none());
    assert!(r.get_lock(LOAN.into()).is_none());
    assert_eq!(r.nft_supply_for_owner(harbor_acct()).0, 0);
    assert_eq!(pledge_as(&mut r, &meridian_acct(), &meridian_acct(), LOAN, "invoices", NOW + 10), PledgeOutcome::Pledged { token_id: LOAN.into() });
}

#[test]
#[should_panic(expected = "servicer only")]
fn only_the_servicer_releases() {
    let (mut r, _) = setup();
    pledge_as(&mut r, &harbor_acct(), &harbor_acct(), LOAN, "invoices", NOW);
    r.release_loan(LOAN.into());
}

#[test]
#[should_panic(expected = "caller is not a registered fund account")]
fn unregistered_account_cannot_pledge() {
    let (mut r, _) = setup();
    pledge_as(&mut r, &accounts(4), &accounts(4), LOAN, "invoices", NOW);
}

#[test]
#[should_panic(expected = "asset_type must be real_estate or invoices")]
fn equipment_is_not_in_the_demo_book() {
    let (mut r, _) = setup();
    pledge_as(&mut r, &harbor_acct(), &harbor_acct(), LOAN, "equipment", NOW);
}

#[test]
#[should_panic(expected = "pledge tokens are not transferable")]
fn pledge_tokens_cannot_be_transferred() {
    let (mut r, _) = setup();
    pledge_as(&mut r, &harbor_acct(), &harbor_acct(), LOAN, "invoices", NOW);
    r.nft_transfer(meridian_acct(), LOAN.into(), None, None);
}

#[test]
fn canonical_message_is_pipe_joined_and_includes_the_contract_id() {
    let c = harbor_cert(NOW);
    let m = canonical_message(CONTRACT, &c);
    assert!(m.starts_with("truenav-cert-v1|registry.test.near|harbor-credit-fund|"));
    assert!(m.ends_with("|bc84b01"));
    assert_eq!(m.split('|').count(), 17);
}

// ---------- audit of 6 Nov (Gemini findings checked by test) ----------

fn ctx_deposit(predecessor: &AccountId, now_ms: u64, deposit_yocto: u128) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(CONTRACT.parse().unwrap())
        .predecessor_account_id(predecessor.clone())
        .block_timestamp(now_ms * 1_000_000)
        .attached_deposit(near_sdk::NearToken::from_yoctonear(deposit_yocto));
    testing_env!(b.build());
}

/// Gemini finding 1 (claimed: pledge always panics without #[payable]) is false: the mint passes no
/// refund account, so no storage deposit is checked and the contract's own balance pays the storage.
/// (Since the hardening of 6 Nov a pledge carries exactly 1 yoctoNEAR, which proves a full-access key.)
#[test]
fn audit_1_pledge_needs_no_deposit_contract_pays_storage() {
    let (mut r, _) = setup();
    let before = near_sdk::env::storage_usage();
    assert_eq!(pledge_as(&mut r, &harbor_acct(), &harbor_acct(), LOAN, "real_estate", NOW), PledgeOutcome::Pledged { token_id: LOAN.into() });
    assert!(near_sdk::env::storage_usage() > before);
}

/// Gemini finding 4 (claimed: release keeps a storage deposit the fund paid) is false: no deposit was
/// taken, so there is nothing to refund, and release creates no transfer receipt.
#[test]
fn audit_4_release_has_no_deposit_to_refund() {
    let (mut r, _) = setup();
    pledge_as(&mut r, &harbor_acct(), &harbor_acct(), LOAN, "real_estate", NOW);
    ctx(&servicer(), NOW + 5);
    r.release_loan(LOAN.into());
    assert!(near_sdk::test_utils::get_created_receipts().is_empty());
}

/// A signed refusal stores the nonce and one attempt on the signing fund. It does not alert the holder.
#[test]
fn audit_2_signed_refusal_stores_a_nonce_and_counts_the_signer_only() {
    let (mut r, _) = setup();
    pledge_as(&mut r, &harbor_acct(), &harbor_acct(), LOAN, "real_estate", NOW);
    near_sdk::env::state_write(&r);
    drop(r);
    ctx_deposit(&meridian_acct(), NOW + 1, 1);
    let before = near_sdk::env::storage_usage();
    let mut r: Registry = near_sdk::env::state_read().unwrap();
    assert!(matches!(pledge_as(&mut r, &meridian_acct(), &meridian_acct(), LOAN, "real_estate", NOW + 1), PledgeOutcome::Refused { .. }));
    assert_eq!(r.get_attempts_page("meridian-yield-fund".into(), 0, 10).count, 1);
    assert_eq!(r.get_alert_count("harbor-credit-fund".into()), 0);
    near_sdk::env::state_write(&r);
    drop(r);
    assert!(near_sdk::env::storage_usage() > before);
}

/// Refusals do not fill the attempt or alert lists. Empty pages stay empty, and the page limit still applies to certificates.
#[test]
fn audit_3_refusals_do_not_fill_attempt_or_alert_pages() {
    let (mut r, _) = setup();
    pledge_as(&mut r, &harbor_acct(), &harbor_acct(), LOAN, "real_estate", NOW);
    for i in 0..5u64 {
        pledge_as(&mut r, &meridian_acct(), &meridian_acct(), LOAN, "real_estate", NOW + 1 + i);
    }
    let p = r.get_attempts_page("meridian-yield-fund".into(), 1, 2);
    assert_eq!(p.count, 5);
    assert_eq!(p.attempts.len(), 2);
    assert_eq!(r.get_alerts_page("harbor-credit-fund".into(), 0, 1000), Vec::<u64>::new());
    assert_eq!(r.get_alert_count("harbor-credit-fund".into()), 0);
    assert_eq!(r.get_alert_count("meridian-yield-fund".into()), 5);
    assert_eq!(r.get_alerts_page("nobody".into(), 0, 10), Vec::<u64>::new());
}

#[test]
fn audit_3_certificate_history_read_in_pages() {
    let (mut r, key) = setup();
    for i in 0..3u64 {
        ctx(&admin(), NOW + i);
        let c = harbor_cert(NOW + i);
        let s = sign(&key, &c);
        r.submit_certificate(c, s);
    }
    assert_eq!(r.get_certificate_count("harbor-credit-fund".into()), 3);
    assert_eq!(r.get_certificate_history_page("harbor-credit-fund".into(), 1, 5), vec![NOW + 1, NOW + 2]);
}

/// Own review: a pipe inside a field could make two different certificates share a canonical message.
#[test]
#[should_panic(expected = "must not contain '|'")]
fn audit_pipe_in_fund_id_is_rejected() {
    let (mut r, _) = setup();
    ctx(&admin(), NOW);
    r.register_fund("evil|fund".into(), accounts(4), "manager-x".into());
}

#[test]
#[should_panic(expected = "engine_commit must be at most 64 characters without '|'")]
fn audit_pipe_in_engine_commit_is_rejected() {
    let (mut r, key) = setup();
    ctx(&admin(), NOW);
    let mut c = harbor_cert(NOW);
    c.engine_commit = "abc|def".into();
    let s = sign(&key, &c);
    r.submit_certificate(c, s);
}

// ---------- NEP-171 events and NEP-181 enumeration (owner decision 6 Nov) ----------

#[test]
fn pledge_emits_nft_mint_and_release_emits_nft_burn() {
    let (mut r, _) = setup();
    pledge_as(&mut r, &harbor_acct(), &harbor_acct(), LOAN, "real_estate", NOW);
    let logs = near_sdk::test_utils::get_logs();
    assert!(logs.iter().any(|l| l.starts_with("EVENT_JSON:") && l.contains("\"standard\":\"nep171\"") && l.contains("\"event\":\"nft_mint\"") && l.contains(LOAN)), "{logs:?}");
    ctx(&servicer(), NOW + 5);
    r.release_loan(LOAN.into());
    let logs = near_sdk::test_utils::get_logs();
    assert!(logs.iter().any(|l| l.contains("\"event\":\"nft_burn\"") && l.contains(LOAN) && l.contains(servicer().as_str())), "{logs:?}");
}

#[test]
fn refused_pledge_emits_no_token_event() {
    let (mut r, _) = setup();
    pledge_as(&mut r, &harbor_acct(), &harbor_acct(), LOAN, "real_estate", NOW);
    pledge_as(&mut r, &meridian_acct(), &meridian_acct(), LOAN, "real_estate", NOW + 1);
    assert!(near_sdk::test_utils::get_logs().iter().all(|l| !l.contains("nft_mint")));
}

#[test]
fn enumeration_lists_pledge_tokens() {
    let (mut r, _) = setup();
    pledge_as(&mut r, &harbor_acct(), &harbor_acct(), LOAN, "real_estate", NOW);
    assert_eq!(r.nft_total_supply().0, 1);
    let mine = r.nft_tokens_for_owner(harbor_acct(), None, None);
    assert_eq!(mine.len(), 1);
    assert_eq!(mine[0].token_id, LOAN);
    assert_eq!(r.nft_tokens(None, None).len(), 1);
    ctx(&servicer(), NOW + 5);
    r.release_loan(LOAN.into());
    assert_eq!(r.nft_total_supply().0, 0);
    assert!(r.nft_tokens_for_owner(harbor_acct(), None, None).is_empty());
}

// ---------- hardening of 6 Nov: 1 yoctoNEAR on admin, servicer and pledge calls ----------

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn pledge_without_one_yocto_is_refused() {
    let (mut r, _) = setup();
    ctx_deposit(&harbor_acct(), NOW, 0);
    let nonce = next_nonce();
    let exp = NOW + 60_000;
    let sig = pledge_help::sign_pledge(&pledge_help::servicer_key(), CONTRACT, harbor_acct().as_str(), LOAN, "real_estate", &nonce, exp);
    r.pledge_loan(LOAN.into(), "real_estate".into(), harbor_acct(), nonce, exp, sig, None);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn admin_call_without_one_yocto_is_refused() {
    let (mut r, _) = setup();
    ctx_deposit(&admin(), NOW, 0);
    r.add_signer("0x0000000000000000000000000000000000000001".into());
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn release_without_one_yocto_is_refused() {
    let (mut r, _) = setup();
    pledge_as(&mut r, &harbor_acct(), &harbor_acct(), LOAN, "real_estate", NOW);
    ctx_deposit(&servicer(), NOW + 1, 0);
    r.release_loan(LOAN.into());
}

const LOAN2: &str = "2222222222222222222222222222222222222222222222222222222222222222";

/// Squatter is refused. The real holder keeps the loan. No blocked attempt and no alert against that holder.
#[test]
fn redteam_r2_squat_does_not_penalise_the_real_holder() {
    let (mut r, _) = setup();
    assert_eq!(pledge_as(&mut r, &harbor_acct(), &harbor_acct(), LOAN, "real_estate", NOW), PledgeOutcome::Pledged { token_id: LOAN.into() });
    let nonce = next_nonce();
    let exp = NOW + 60_000;
    let stolen = pledge_help::sign_pledge(&pledge_help::servicer_key(), CONTRACT, harbor_acct().as_str(), LOAN, "real_estate", &nonce, exp);
    ctx(&meridian_acct(), NOW + 1000);
    let out = r.pledge_loan(LOAN.into(), "real_estate".into(), harbor_acct(), nonce.clone(), exp, stolen.clone(), None);
    match out {
        PledgeOutcome::Refused { message, attempt_id } => {
            assert_eq!(message, "caller is not the fund named in the servicer signature");
            assert_eq!(attempt_id, "none");
        }
        other => panic!("expected refusal, got {other:?}"),
    }
    assert_eq!(r.get_attempts_page("harbor-credit-fund".into(), 0, 10).count, 0);
    assert_eq!(r.get_attempts_page("meridian-yield-fund".into(), 0, 10).count, 0);
    assert_eq!(r.get_alert_count("harbor-credit-fund".into()), 0);
    ctx(&harbor_acct(), NOW + 1000);
    assert_eq!(
        r.pledge_loan(LOAN.into(), "real_estate".into(), harbor_acct(), nonce, exp, stolen, None),
        PledgeOutcome::AlreadyYours { token_id: LOAN.into() }
    );
    let own = pledge_as(&mut r, &meridian_acct(), &meridian_acct(), LOAN, "real_estate", NOW + 2000);
    match own {
        PledgeOutcome::Refused { attempt_id, .. } => assert_eq!(attempt_id, "attempt-1"),
        other => panic!("expected a counted refusal, got {other:?}"),
    }
    assert_eq!(r.get_attempts_page("meridian-yield-fund".into(), 0, 10).count, 1);
    assert_eq!(r.get_alert_count("harbor-credit-fund".into()), 0);
    assert_eq!(r.get_alert_count("meridian-yield-fund".into()), 1);
    assert_eq!(r.nft_token(LOAN.into()).unwrap().owner_id, harbor_acct());
}

#[test]
#[should_panic(expected = "servicer signature not from the registered pledge key")]
fn pledge_rejects_a_wrong_signer() {
    let (mut r, _) = setup();
    let nonce = next_nonce();
    let exp = NOW + 60_000;
    let sig = pledge_help::sign_pledge(&test_key(4), CONTRACT, harbor_acct().as_str(), LOAN2, "real_estate", &nonce, exp);
    ctx(&harbor_acct(), NOW);
    r.pledge_loan(LOAN2.into(), "real_estate".into(), harbor_acct(), nonce, exp, sig, None);
}

#[test]
#[should_panic(expected = "pledge nonce already used")]
fn pledge_rejects_a_replayed_nonce() {
    let (mut r, _) = setup();
    let nonce = next_nonce();
    let exp = NOW + 60_000;
    let sig = pledge_help::sign_pledge(&pledge_help::servicer_key(), CONTRACT, harbor_acct().as_str(), LOAN2, "real_estate", &nonce, exp);
    ctx(&harbor_acct(), NOW);
    assert_eq!(r.pledge_loan(LOAN2.into(), "real_estate".into(), harbor_acct(), nonce.clone(), exp, sig.clone(), None), PledgeOutcome::Pledged { token_id: LOAN2.into() });
    ctx(&harbor_acct(), NOW);
    r.pledge_loan(LOAN2.into(), "real_estate".into(), harbor_acct(), nonce, exp, sig, None);
}

#[test]
#[should_panic(expected = "pledge expired")]
fn pledge_rejects_an_expired_signature() {
    let (mut r, _) = setup();
    let nonce = next_nonce();
    let exp = NOW - 1;
    let sig = pledge_help::sign_pledge(&pledge_help::servicer_key(), CONTRACT, harbor_acct().as_str(), LOAN2, "real_estate", &nonce, exp);
    ctx(&harbor_acct(), NOW);
    r.pledge_loan(LOAN2.into(), "real_estate".into(), harbor_acct(), nonce, exp, sig, None);
}

#[test]
#[should_panic(expected = "servicer signature")]
fn pledge_rejects_a_signature_for_another_contract() {
    let (mut r, _) = setup();
    let nonce = next_nonce();
    let exp = NOW + 60_000;
    let msg = truenav_registry::pledge_message("other.test.near", &truenav_registry::network_of(CONTRACT), LOAN2, harbor_acct().as_str(), "real_estate", &nonce, exp);
    let sig = pledge_help::sign_message(&pledge_help::servicer_key(), &msg);
    ctx(&harbor_acct(), NOW);
    r.pledge_loan(LOAN2.into(), "real_estate".into(), harbor_acct(), nonce, exp, sig, None);
}

#[test]
#[should_panic(expected = "servicer signature")]
fn pledge_rejects_a_signature_for_another_network() {
    let (mut r, _) = setup();
    let nonce = next_nonce();
    let exp = NOW + 60_000;
    let msg = truenav_registry::pledge_message(CONTRACT, "testnet", LOAN2, harbor_acct().as_str(), "real_estate", &nonce, exp);
    let sig = pledge_help::sign_message(&pledge_help::servicer_key(), &msg);
    ctx(&harbor_acct(), NOW);
    r.pledge_loan(LOAN2.into(), "real_estate".into(), harbor_acct(), nonce, exp, sig, None);
}

#[test]
#[should_panic(expected = "bad servicer signature")]
fn pledge_rejects_a_malformed_signature() {
    let (mut r, _) = setup();
    ctx(&harbor_acct(), NOW);
    r.pledge_loan(LOAN2.into(), "real_estate".into(), harbor_acct(), next_nonce(), NOW + 60_000, "0x1234".into(), None);
}

#[test]
fn a_tee_verdict_signer_is_not_a_pledge_ticket_signer() {
    let (mut r, _) = setup();
    let ticket_key = pledge_help::ticket_test_key();
    let addr = pledge_help::address_of(&ticket_key);
    ctx(&admin(), NOW);
    r.add_tee_signer(addr.clone(), "local-test-model".into(), "local test key, not a TEE".into(), "ab".repeat(32));
    assert!(r.get_pledge_signers().is_empty());
    assert_eq!(pledge_as(&mut r, &harbor_acct(), &harbor_acct(), LOAN2, "invoices", NOW), PledgeOutcome::Pledged { token_id: LOAN2.into() });
}

#[test]
#[should_panic(expected = "ticket signature required")]
fn a_registered_ticket_signer_makes_a_ticket_required() {
    let (mut r, _) = setup();
    ctx(&admin(), NOW);
    r.add_pledge_signer(pledge_help::address_of(&pledge_help::ticket_test_key()), "local test key standing in for a TEE key".into(), "cd".repeat(32));
    pledge_as(&mut r, &meridian_acct(), &meridian_acct(), LOAN2, "invoices", NOW);
}

#[test]
fn a_local_test_key_ticket_is_accepted_and_a_servicer_signature_is_not_a_ticket() {
    let (mut r, _) = setup();
    let ticket_key = pledge_help::ticket_test_key();
    ctx(&admin(), NOW);
    r.add_pledge_signer(pledge_help::address_of(&ticket_key), "LOCAL TEST KEY standing in for the TEE pledge key. Not a TEE key.".into(), "cd".repeat(32));
    let nonce = next_nonce();
    let exp = NOW + 60_000;
    let ticket = pledge_help::sign_pledge(&ticket_key, CONTRACT, meridian_acct().as_str(), LOAN2, "invoices", &nonce, exp);
    assert_eq!(
        pledge_as_nonce(&mut r, &meridian_acct(), &meridian_acct(), LOAN2, "invoices", &nonce, NOW, exp, Some(ticket)),
        PledgeOutcome::Pledged { token_id: LOAN2.into() }
    );
}

#[test]
#[should_panic(expected = "ticket signer not registered")]
fn a_servicer_signature_is_not_a_pledge_ticket() {
    let (mut r, _) = setup();
    ctx(&admin(), NOW);
    r.add_pledge_signer(pledge_help::address_of(&pledge_help::ticket_test_key()), "LOCAL TEST KEY standing in for the TEE pledge key. Not a TEE key.".into(), "cd".repeat(32));
    let nonce = next_nonce();
    let exp = NOW + 60_000;
    let servicer_sig = pledge_help::sign_pledge(&pledge_help::servicer_key(), CONTRACT, harbor_acct().as_str(), LOAN, "real_estate", &nonce, exp);
    let servicer_as_ticket = servicer_sig.clone();
    ctx(&harbor_acct(), NOW);
    r.pledge_loan(LOAN.into(), "real_estate".into(), harbor_acct(), nonce, exp, servicer_sig, Some(servicer_as_ticket));
}

#[test]
#[test]
#[should_panic(expected = "ticket signature required")]
fn removing_the_last_ticket_signer_does_not_drop_the_requirement() {
    let (mut r, _) = setup();
    let addr = pledge_help::address_of(&pledge_help::ticket_test_key());
    ctx(&admin(), NOW);
    r.add_pledge_signer(addr.clone(), "local test key, not a TEE".into(), "cd".repeat(32));
    ctx(&admin(), NOW);
    r.remove_pledge_signer(addr);
    assert!(r.get_pledge_signers().is_empty());
    pledge_as(&mut r, &harbor_acct(), &harbor_acct(), LOAN2, "real_estate", NOW);
}

#[test]
#[should_panic(expected = "pledge expiry too far")]
fn pledge_rejects_an_expiry_past_24h() {
    let (mut r, _) = setup();
    let nonce = next_nonce();
    let exp = NOW + truenav_registry::PLEDGE_TTL_MS + 1;
    let sig = pledge_help::sign_pledge(&pledge_help::servicer_key(), CONTRACT, harbor_acct().as_str(), LOAN2, "real_estate", &nonce, exp);
    ctx(&harbor_acct(), NOW);
    r.pledge_loan(LOAN2.into(), "real_estate".into(), harbor_acct(), nonce, exp, sig, None);
}

#[test]
#[should_panic(expected = "bad servicer signature")]
fn pledge_rejects_a_high_s_signature() {
    let (mut r, _) = setup();
    let nonce = next_nonce();
    let exp = NOW + 60_000;
    let sig = pledge_help::sign_pledge(&pledge_help::servicer_key(), CONTRACT, harbor_acct().as_str(), LOAN2, "real_estate", &nonce, exp);
    let raw = hex::decode(sig.trim_start_matches("0x")).unwrap();
    let n = hex::decode("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141").unwrap();
    let mut s = raw[32..64].to_vec();
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let diff = n[i] as i16 - s[i] as i16 - borrow;
        if diff < 0 {
            s[i] = (diff + 256) as u8;
            borrow = 1;
        } else {
            s[i] = diff as u8;
            borrow = 0;
        }
    }
    let mut hi = raw[..32].to_vec();
    hi.extend_from_slice(&s);
    hi.push(raw[64]);
    let bad = format!("0x{}", hex::encode(hi));
    ctx(&harbor_acct(), NOW);
    r.pledge_loan(LOAN2.into(), "real_estate".into(), harbor_acct(), nonce, exp, bad, None);
}

#[test]
fn a_second_signed_refusal_uses_the_next_attempt_seq() {
    let (mut r, _) = setup();
    pledge_as(&mut r, &harbor_acct(), &harbor_acct(), LOAN, "real_estate", NOW);
    let other = "33".repeat(32);
    pledge_as(&mut r, &harbor_acct(), &harbor_acct(), &other, "real_estate", NOW);
    let first = pledge_as(&mut r, &meridian_acct(), &meridian_acct(), LOAN, "real_estate", NOW + 1);
    let second = pledge_as(&mut r, &meridian_acct(), &meridian_acct(), &other, "real_estate", NOW + 2);
    match (first, second) {
        (PledgeOutcome::Refused { attempt_id: a, .. }, PledgeOutcome::Refused { attempt_id: b, .. }) => {
            assert_eq!(a, "attempt-1");
            assert_eq!(b, "attempt-2");
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(r.get_attempts_page("meridian-yield-fund".into(), 0, 10).count, 2);
    assert_eq!(r.get_attempts_page("harbor-credit-fund".into(), 0, 10).count, 0);
}
