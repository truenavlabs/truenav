use near_sdk::{
    borsh::{self, BorshDeserialize, BorshSerialize},
    json_types::U128,
    mock::MockAction,
    serde_json::{self, json, Value},
    store::{IterableMap, IterableSet, LookupMap},
    test_utils::{get_created_receipts, get_logs, VMContextBuilder},
    testing_env, AccountId, Gas, NearToken, PromiseResult, RuntimeFeesConfig,
};
use truenav_receipts::{
    mirror::{self, MirrorConfig},
    Config, Failure, Pending, Receipts, StoredReceipt, TokenInfo,
};
fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn context(who: &str, results: Vec<PromiseResult>) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("receipts.truenav.testnet"))
        .predecessor_account_id(acc(who))
        .signer_account_id(acc(who))
        .attached_deposit(NearToken::from_yoctonear(1))
        .prepaid_gas(Gas::from_tgas(300))
        .account_balance(NearToken::from_near(10));
    testing_env!(
        b.build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        results
    );
}
fn vector(i: usize) -> Value {
    serde_json::from_str::<Value>(include_str!("../../mirror/fixtures/vectors.json")).unwrap()[i]
        .clone()
}
fn config() -> Config {
    Config {
        outlayer: acc("outlayer.testnet"),
        project_id: "receipts.truenav.testnet/truenav-engine".into(),
        version_key: "36".repeat(32),
        method: "cashflow-v2.1.0".into(),
        secrets_profile: "engine".into(),
        secrets_owner: acc("receipts.truenav.testnet"),
        max_instructions: 10000000000,
        max_memory_mb: 128,
        max_execution_seconds: 30,
        outlayer_deposit: U128(1),
        storage_deposit: U128(250000000000000000000000),
        outlayer_tgas: 230,
        callback_tgas: 50,
    }
}
fn receipt(v: &Value) -> StoredReceipt {
    StoredReceipt {
        token_id: "DEMO-CREDIT".into(),
        seq: v["seq"].as_u64().unwrap(),
        request_id: 1,
        method: "cashflow-v2.1.0".into(),
        version_key: "36".repeat(32),
        score: 58,
        band: "red".into(),
        period: "2026-10".into(),
        as_of: v["as_of"].as_str().unwrap().into(),
        caps: vec![],
        holds: vec![],
        receipt_sha256: "aa".repeat(32),
        receipt: "{}".into(),
        requested_ns: 1,
        stored_ns: 2,
        block_height: 3,
    }
}
// Independent pre-mirror deployed layout, including the original collection prefix order. No mirror fields.
#[derive(BorshSerialize, BorshDeserialize)]
#[borsh(crate = "near_sdk::borsh")]
struct Legacy {
    admin: AccountId,
    proposed_admin: Option<AccountId>,
    pauser: AccountId,
    paused: bool,
    config: Config,
    next_request: u64,
    tokens: IterableMap<String, TokenInfo>,
    runners: IterableSet<AccountId>,
    pending: LookupMap<String, Pending>,
    receipts: LookupMap<(String, u64), StoredReceipt>,
    failures: LookupMap<String, Failure>,
}
fn setup() -> Receipts {
    context("admin.testnet", vec![]);
    let mut old = Legacy {
        admin: acc("admin.testnet"),
        proposed_admin: None,
        pauser: acc("pauser.testnet"),
        paused: false,
        config: config(),
        next_request: 7,
        tokens: IterableMap::new(vec![0]),
        runners: IterableSet::new(vec![1]),
        pending: LookupMap::new(vec![2]),
        receipts: LookupMap::new(vec![3]),
        failures: LookupMap::new(vec![4]),
    };
    old.tokens.insert(
        "DEMO-CREDIT".into(),
        TokenInfo {
            token_id: "DEMO-CREDIT".into(),
            kind: "credit".into(),
            receipts: 1,
            registered_ns: 0,
        },
    );
    old.receipts
        .insert(("DEMO-CREDIT".into(), 1), receipt(&vector(0)));
    old.tokens.flush();
    old.receipts.flush();
    near_sdk::env::state_write(&old);
    drop(old);
    near_sdk::env::state_read().unwrap()
}
fn mc() -> MirrorConfig {
    MirrorConfig {
        chain_id: 84532,
        mirror_address: vector(0)["to"].as_str().unwrap().into(),
        fee_cap: 100000000000,
        public_key: vector(0)["public_key"].as_str().unwrap().into(),
    }
}
fn start() -> Receipts {
    let mut c = setup();
    c.set_mirror_config(mc());
    c.request_mirror("DEMO-CREDIT".into(), 1, 1000000000)
        .detach();
    c
}
fn response(c: &mut Receipts, v: Value) -> bool {
    context(
        "receipts.truenav.testnet",
        vec![PromiseResult::Successful(serde_json::to_vec(&v).unwrap())],
    );
    c.on_mirror_signed(0, 0)
}
fn panics(f: impl FnOnce()) {
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).is_err());
}
#[test]
fn old_state_loads_without_migration_and_root_bytes_stay_identical() {
    let mut c = setup();
    let before = borsh::to_vec(&c).unwrap();
    assert_eq!(c.get_config()["next_request"], 7);
    assert_eq!(c.get_latest("DEMO-CREDIT".into()).unwrap().score, 58);
    c.set_mirror_config(mc());
    assert_eq!(borsh::to_vec(&c).unwrap(), before);
    c.request_mirror("DEMO-CREDIT".into(), 1, 1000000000)
        .detach();
    assert_eq!(borsh::to_vec(&c).unwrap(), before);
    assert!(borsh::from_slice::<Legacy>(&before).is_ok());
}
#[test]
fn abi_rlp_signing_hash_and_signed_bytes_match_viem() {
    context("admin.testnet", vec![]);
    for i in 0..3 {
        let v = vector(i);
        let r = receipt(&v);
        let data = mirror::calldata(&r);
        assert_eq!(
            data,
            mirror::unhex(v["data"].as_str().unwrap(), 228).unwrap()
        );
        let tx = mirror::transaction(
            v["nonce"].as_u64().unwrap(),
            v["fee"].as_u64().unwrap(),
            &mirror::unhex(v["to"].as_str().unwrap(), 20).unwrap(),
            &data,
            None,
        );
        assert_eq!(
            tx,
            mirror::unhex(
                v["unsigned"].as_str().unwrap(),
                v["unsigned"].as_str().unwrap().len() / 2
            )
            .unwrap()
        );
        assert_eq!(
            near_sdk::env::keccak256(&tx),
            mirror::unhex(v["hash"].as_str().unwrap(), 32).unwrap()
        );
    }
    let mut c = start();
    assert!(response(&mut c, vector(0)["response"].clone()));
    let r = c.get_mirror_request(0).unwrap();
    assert_eq!(
        r.attempts[0].signed_tx.as_deref(),
        vector(0)["signed"].as_str()
    );
    assert!(get_logs().iter().any(|s| s.contains("mirror_signed")));
}
#[test]
fn only_the_stored_receipt_is_signed_with_the_fixed_path_domain_and_signer() {
    let c = start();
    let r = c.get_mirror_request(0).unwrap();
    assert_eq!(r.seq, 1);
    assert_eq!(r.nonce, 0);
    let receipts = get_created_receipts();
    let sign = receipts
        .iter()
        .find(|r| r.receiver_id == acc("v1.signer-prod.testnet"))
        .unwrap();
    for a in &sign.actions {
        if let MockAction::FunctionCallWeight {
            method_name,
            args,
            attached_deposit,
            ..
        } = a
        {
            assert_eq!(method_name, b"sign");
            assert_eq!(*attached_deposit, NearToken::from_yoctonear(1));
            let v: Value = serde_json::from_slice(args).unwrap();
            assert_eq!(
                v,
                json!({"request":{"path":"truenav-mirror-v1","domain_id":0,"payload_v2":{"Ecdsa":vector(0)["hash"]}}})
            );
        }
    }
}
#[test]
fn configuration_role_chain_cap_pause_and_missing_receipt_fail_closed() {
    let mut c = setup();
    context("stranger.testnet", vec![]);
    panics(|| c.set_mirror_config(mc()));
    context("admin.testnet", vec![]);
    let mut bad = mc();
    bad.chain_id = 1;
    panics(|| c.set_mirror_config(bad));
    let mut bad = mc();
    bad.fee_cap = 100000000001;
    panics(|| c.set_mirror_config(bad));
    c.set_mirror_config(mc());
    panics(|| {
        c.request_mirror("MISSING".into(), 1, 1).detach();
    });
    c.pause();
    panics(|| {
        c.request_mirror("DEMO-CREDIT".into(), 1, 1).detach();
    });
}
#[test]
fn callback_failure_and_bad_signatures_keep_nonce_and_allow_fee_bump() {
    let mut c = start();
    assert!(!response(&mut c, json!({"bad":"signature"})));
    context("admin.testnet", vec![]);
    panics(|| {
        c.resign_mirror(0, 1000000000).detach();
    });
    c.resign_mirror(0, 1100000000).detach();
    let r = c.get_mirror_request(0).unwrap();
    assert_eq!(r.attempts.len(), 2);
    assert_eq!(
        r.data,
        mirror::unhex(vector(0)["data"].as_str().unwrap(), 228).unwrap()
    );
    context("receipts.truenav.testnet", vec![PromiseResult::Failed]);
    assert!(!c.on_mirror_signed(0, 1));
    context("admin.testnet", vec![]);
    panics(|| {
        c.resign_mirror(0, 100000000001).detach();
    });
    assert_eq!(c.get_mirror_config().unwrap().next_nonce, 0);
}
#[test]
fn confirmation_requires_admin_and_exact_known_signed_hash_before_nonce_can_advance() {
    let mut c = start();
    context("admin.testnet", vec![]);
    panics(|| {
        c.request_mirror("DEMO-CREDIT".into(), 1, 1).detach();
    });
    panics(|| c.set_mirror_config(mc()));
    context(
        "receipts.truenav.testnet",
        vec![PromiseResult::Successful(
            serde_json::to_vec(&vector(0)["response"]).unwrap(),
        )],
    );
    assert!(c.on_mirror_signed(0, 0));
    context("stranger.testnet", vec![]);
    panics(|| c.confirm_mirror(0, vector(0)["tx_hash"].as_str().unwrap().into()));
    context("admin.testnet", vec![]);
    panics(|| c.confirm_mirror(0, "bb".repeat(32)));
    c.confirm_mirror(0, vector(0)["tx_hash"].as_str().unwrap().into());
    assert_eq!(c.get_mirror_config().unwrap().next_nonce, 1);
    panics(|| c.confirm_mirror(0, vector(0)["tx_hash"].as_str().unwrap().into()));
    c.request_mirror("DEMO-CREDIT".into(), 1, 1000000000)
        .detach();
    assert_eq!(c.get_mirror_request(1).unwrap().nonce, 1);
}
#[test]
fn as_of_parser_checks_real_dates_utc_epoch_milliseconds_and_clock_ranges() {
    assert_eq!(mirror::as_of_ms("1970-01-01T00:00:00Z"), Some(0));
    assert_eq!(
        mirror::as_of_ms("2000-02-29T00:00:00.123Z"),
        Some(951782400123)
    );
    for s in [
        "2026-02-31T00:00:00Z",
        "2026-01-01T24:00:00Z",
        "2026-01-01T00:00:60Z",
        "1969-01-01T00:00:00Z",
        "2026-01-01T00:00:00+01:00",
    ] {
        assert_eq!(mirror::as_of_ms(s), None);
    }
}

#[test]
fn high_s_signatures_are_normalized_to_the_same_ethereum_transaction() {
    let mut c = start();
    let mut v = vector(0)["response"].clone();
    let s = mirror::unhex(v["s"]["scalar"].as_str().unwrap(), 32).unwrap();
    let order = mirror::unhex(
        "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
        32,
    )
    .unwrap();
    let mut high = [0u8; 32];
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let n = order[i] as i16 - s[i] as i16 - borrow;
        high[i] = n as u8;
        borrow = i16::from(n < 0);
    }
    v["s"]["scalar"] = json!(high.iter().map(|b| format!("{b:02x}")).collect::<String>());
    let recovery = v["recovery_id"].as_u64().unwrap() ^ 1;
    v["recovery_id"] = json!(recovery);
    let point = v["big_r"]["affine_point"].as_str().unwrap().to_string();
    v["big_r"]["affine_point"] = json!(format!("{:02x}{}", 2 + recovery, &point[2..]));
    assert!(response(&mut c, v));
    assert_eq!(
        c.get_mirror_request(0).unwrap().attempts[0]
            .signed_tx
            .as_deref(),
        vector(0)["signed"].as_str()
    );
}

#[test]
fn signature_for_other_payload_is_not_emitted_and_old_callback_cannot_overwrite() {
    let mut c = start();
    assert!(!response(&mut c, vector(1)["response"].clone()));
    assert!(c.get_mirror_request(0).unwrap().attempts[0]
        .signed_tx
        .is_none());
    assert!(!c.on_mirror_signed(0, 0));
    context("admin.testnet", vec![]);
    c.resign_mirror(0, 1200000000).detach();
    context(
        "receipts.truenav.testnet",
        vec![PromiseResult::Successful(
            serde_json::to_vec(&vector(0)["response"]).unwrap(),
        )],
    );
    assert!(!c.on_mirror_signed(0, 0));
    assert!(c.get_mirror_request(0).unwrap().signing);
}

#[test]
fn a_mined_earlier_replacement_can_be_confirmed_after_a_newer_signature() {
    let mut c = start();
    assert!(response(&mut c, vector(0)["response"].clone()));
    context("admin.testnet", vec![]);
    c.resign_mirror(0, 1200000000).detach();
    context(
        "receipts.truenav.testnet",
        vec![PromiseResult::Successful(
            serde_json::to_vec(&vector(3)["response"]).unwrap(),
        )],
    );
    assert!(c.on_mirror_signed(0, 1));
    let request = c.get_mirror_request(0).unwrap();
    assert_eq!(
        request.attempts[1].signed_tx.as_deref(),
        vector(3)["signed"].as_str()
    );
    assert_eq!(
        request.data,
        mirror::unhex(vector(0)["data"].as_str().unwrap(), 228).unwrap()
    );
    context("admin.testnet", vec![]);
    c.confirm_mirror(0, vector(0)["tx_hash"].as_str().unwrap().into());
    assert_eq!(c.get_mirror_config().unwrap().next_nonce, 1);
}
