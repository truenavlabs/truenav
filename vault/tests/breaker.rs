// The circuit-breaker rule and the vault's callback: subscribed when the fund's latest certificate is scored,
// not red and fresh; refused (deposit refunded) when it is missing, for another fund, not scored, red or stale.
use near_sdk::json_types::U128;
use near_sdk::test_utils::{accounts, VMContextBuilder};
use near_sdk::{testing_env, NearToken, PromiseError};
use truenav_vault::{check_certificate, CertificateView, StoredCertificateView, Vault, DEFAULT_MAX_AGE_MS};

const NOW: u64 = 1_794_000_000_000;
fn cert(band: &str, score: Option<u8>, status: &str, age_ms: u64) -> Option<StoredCertificateView> {
    Some(StoredCertificateView { certificate: CertificateView { fund_id: "harbor-credit-fund".into(), status: status.into(), score, band: band.into(), signed_at_ms: NOW - age_ms }, signer: "0xabc".into() })
}

#[test]
fn green_and_yellow_fresh_certificates_are_accepted() {
    assert_eq!(check_certificate(&cert("green", Some(99), "scored", 0), "harbor-credit-fund", NOW, DEFAULT_MAX_AGE_MS), Ok(()));
    assert_eq!(check_certificate(&cert("yellow", Some(70), "scored", 3_600_000), "harbor-credit-fund", NOW, DEFAULT_MAX_AGE_MS), Ok(()));
}

#[test]
fn red_missing_unscored_foreign_and_stale_are_refused() {
    let f = "harbor-credit-fund";
    assert_eq!(check_certificate(&cert("red", Some(43), "scored", 0), f, NOW, DEFAULT_MAX_AGE_MS), Err("red"));
    assert_eq!(check_certificate(&None, f, NOW, DEFAULT_MAX_AGE_MS), Err("no certificate"));
    assert_eq!(check_certificate(&cert("", None, "disclaimed", 0), f, NOW, DEFAULT_MAX_AGE_MS), Err("not scored"));
    assert_eq!(check_certificate(&cert("green", None, "scored", 0), f, NOW, DEFAULT_MAX_AGE_MS), Err("not scored"));
    assert_eq!(check_certificate(&cert("green", Some(99), "scored", 0), "meridian-yield-fund", NOW, DEFAULT_MAX_AGE_MS), Err("no certificate"));
    assert_eq!(check_certificate(&cert("green", Some(99), "scored", DEFAULT_MAX_AGE_MS + 1), f, NOW, DEFAULT_MAX_AGE_MS), Err("stale"));
    assert_eq!(check_certificate(&cert("green", Some(99), "scored", DEFAULT_MAX_AGE_MS), f, NOW, DEFAULT_MAX_AGE_MS), Ok(()));
}

fn ctx(pred: usize, deposit: u128) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(accounts(0)).predecessor_account_id(accounts(pred)).block_timestamp(NOW * 1_000_000).attached_deposit(NearToken::from_yoctonear(deposit));
    testing_env!(b.build());
}

#[test]
fn callback_mints_shares_only_when_accepted() {
    ctx(1, 0);
    let mut v = Vault::new(accounts(2), "harbor-credit-fund".into(), None);
    ctx(0, 0);
    let ok = v.on_certificate(accounts(3), U128(5), Ok(cert("green", Some(99), "scored", 0)));
    assert_eq!((ok.outcome.as_str(), ok.reason.as_str()), ("subscribed", ""));
    assert_eq!(v.get_shares(accounts(3)).0, 5);
    let red = v.on_certificate(accounts(4), U128(7), Ok(cert("red", Some(43), "scored", 0)));
    assert_eq!((red.outcome.as_str(), red.reason.as_str()), ("refused", "red"));
    assert_eq!(v.get_shares(accounts(4)).0, 0);
    let gone = v.on_certificate(accounts(4), U128(7), Err(PromiseError::Failed));
    assert_eq!(gone.reason, "no certificate");
    assert_eq!(v.get_config().4 .0, 5);
}

#[test]
#[should_panic(expected = "owner only")]
fn only_the_owner_sets_the_max_age() {
    ctx(1, 0);
    let mut v = Vault::new(accounts(2), "harbor-credit-fund".into(), None);
    ctx(3, 1);
    v.set_max_age_ms(60_000);
}

#[test]
#[should_panic(expected = "attach at least 0.001 NEAR")]
fn a_dust_subscription_is_refused() {
    ctx(1, 0);
    let mut v = Vault::new(accounts(2), "harbor-credit-fund".into(), None);
    ctx(3, 10);
    let _ = v.subscribe();
}
