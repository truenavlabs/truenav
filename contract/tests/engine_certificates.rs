// End to end, offline: certificates produced and signed by the JS score engine (certify/run.mjs --fixture)
// must verify and store on the contract. Regenerate the fixture with `node certify/run.mjs --fixture`.
use near_sdk::serde_json::{self, Value};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, AccountId};
use truenav_registry::{Certificate, Registry};

fn ctx(contract: &str, predecessor: &str, now_ms: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(contract.parse().unwrap())
        .predecessor_account_id(predecessor.parse::<AccountId>().unwrap())
        .block_timestamp(now_ms * 1_000_000)
        .attached_deposit(near_sdk::NearToken::from_yoctonear(1)); // admin calls need 1 yocto
    testing_env!(b.build());
}

#[test]
fn engine_signed_certificates_verify_on_the_contract() {
    let raw = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/engine-certificates.json")).unwrap();
    let fx: Value = serde_json::from_str(&raw).unwrap();
    let contract = fx["contract_id"].as_str().unwrap();
    let admin = fx["admin"].as_str().unwrap();
    let now = fx["certificates"][0]["certificate"]["signed_at_ms"].as_u64().unwrap();

    ctx(contract, admin, now);
    let mut r = Registry::new(admin.parse().unwrap(), fx["servicer"].as_str().unwrap().parse().unwrap());
    r.add_signer(fx["signer_address"].as_str().unwrap().to_string());
    for f in fx["funds"].as_array().unwrap() {
        r.register_fund(
            f["fund_id"].as_str().unwrap().into(),
            f["account_id"].as_str().unwrap().parse().unwrap(),
            f["manager_id"].as_str().unwrap().into(),
        );
    }

    let mut seen = vec![];
    for item in fx["certificates"].as_array().unwrap() {
        let cert: Certificate = serde_json::from_value(item["certificate"].clone()).unwrap();
        let sig = item["signature"].as_str().unwrap().to_string();
        let stored = r.submit_certificate(cert.clone(), sig);
        assert_eq!(stored.signer, fx["signer_address"].as_str().unwrap());
        seen.push((cert.fund_id.clone(), cert.score, cert.raw_x100, cert.band.clone()));
    }
    // Demo pins: Harbor 99.17 green, Meridian 42.84 red.
    assert!(seen.contains(&("harbor-credit-fund".to_string(), Some(99), 9917, "green".to_string())));
    assert!(seen.contains(&("meridian-yield-fund".to_string(), Some(43), 4284, "red".to_string())));
}

#[test]
#[should_panic(expected = "signer not registered")]
fn engine_certificate_with_an_edited_score_is_rejected() {
    let raw = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/engine-certificates.json")).unwrap();
    let fx: Value = serde_json::from_str(&raw).unwrap();
    let contract = fx["contract_id"].as_str().unwrap();
    let admin = fx["admin"].as_str().unwrap();
    let item = &fx["certificates"][1];
    let now = item["certificate"]["signed_at_ms"].as_u64().unwrap();
    ctx(contract, admin, now);
    let mut r = Registry::new(admin.parse().unwrap(), fx["servicer"].as_str().unwrap().parse().unwrap());
    r.add_signer(fx["signer_address"].as_str().unwrap().to_string());
    for f in fx["funds"].as_array().unwrap() {
        r.register_fund(f["fund_id"].as_str().unwrap().into(), f["account_id"].as_str().unwrap().parse().unwrap(), f["manager_id"].as_str().unwrap().into());
    }
    let mut cert: Certificate = serde_json::from_value(item["certificate"].clone()).unwrap();
    cert.score = Some(90);
    cert.band = "green".into();
    cert.raw_x100 = 9000;
    r.submit_certificate(cert, item["signature"].as_str().unwrap().to_string());
}
