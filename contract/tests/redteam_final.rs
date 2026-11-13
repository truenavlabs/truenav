// Red-team final pass (13 Nov 2026): signature edge cases, replay across v forms, the body size limit and the
// expiry boundary on submit_verdict. Every case here is checked against the contract as it is; none of these
// tests changes contract logic. The TEE key below is a LOCAL TEST KEY, not a TEE key.
use k256::ecdsa::SigningKey;
use near_sdk::serde_json::json;
use near_sdk::test_utils::{accounts, VMContextBuilder};
use near_sdk::{testing_env, AccountId};
use truenav_registry::{eip191_digest, recover_address, Registry, VERDICT_DOMAIN};

#[path = "pledge_help.rs"]
mod pledge_help;

const CONTRACT: &str = "registry.test.near";
const MODEL: &str = "Test/Model";
/// secp256k1 group order n, big endian.
const N: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe,
    0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
];

fn ctx_at(predecessor: &AccountId, now_ms: u64, yocto: u128) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(CONTRACT.parse().unwrap())
        .predecessor_account_id(predecessor.clone())
        .block_timestamp(now_ms * 1_000_000)
        .attached_deposit(near_sdk::NearToken::from_yoctonear(yocto));
    testing_env!(b.build());
}
fn admin() -> AccountId { accounts(0) }
fn servicer() -> AccountId { accounts(1) }
fn harbor() -> AccountId { accounts(2) }

fn test_tee() -> (SigningKey, String) {
    let k = SigningKey::from_bytes(&[13u8; 32].into()).unwrap();
    let addr = pledge_help::address_of(&k);
    (k, addr)
}

const T: u64 = 1_793_000_000_000;

thread_local!(static SEQ: std::cell::Cell<u64> = const { std::cell::Cell::new(0) });

/// A registry with one registered fund, a pledged loan and the local test TEE signer. Each setup clears the mocked
/// storage and pledges a different loan hash, so no case sees another case's state.
fn setup() -> (Registry, SigningKey, String) {
    // start from empty mocked storage, so each case is a fresh registry
    near_sdk::mock::with_mocked_blockchain(|b| drop(b.take_storage()));
    let (key, addr) = test_tee();
    ctx_at(&admin(), T, 1);
    let mut r = Registry::new(admin(), servicer());
    r.register_fund("harbor-credit-fund".into(), harbor(), "manager-harbor".into());
    r.set_servicer_pledge_key(pledge_help::address_of(&pledge_help::servicer_key()));
    r.add_tee_signer(addr, MODEL.into(), "local test key".into(), "a".repeat(64));
    let loan = format!("{:064x}", 0xb000 + SEQ.with(|c| { c.set(c.get() + 1); c.get() }));
    let exp = T + 60_000;
    let sig = pledge_help::sign_pledge(&pledge_help::servicer_key(), CONTRACT, harbor().as_str(), &loan, "real_estate", &loan, exp);
    ctx_at(&harbor(), T, 1);
    r.pledge_loan(loan.clone(), "real_estate".into(), harbor(), loan.clone(), exp, sig, None);
    (r, key, loan)
}

/// A clean pass reply in the gateway's shape. `id` pads the outer body (the contract does not read it).
fn body_for(loan: &str, expires_at_ms: u64, id: &str) -> String {
    let grouped: Vec<String> = loan.as_bytes().chunks(8).map(|c| String::from_utf8(c.to_vec()).unwrap()).collect();
    let binding = format!("{VERDICT_DOMAIN}|{CONTRACT}|mainnet|{expires_at_ms}");
    let content = json!({"loan_hash": grouped.join(" "), "binding": binding, "id_mismatch": "ok", "asset_mismatch": "ok",
        "amount_mismatch": "ok", "duplicate_document": "ok", "duplicate_evidence_line": "ok", "injection_attempt": "ok",
        "unreadable": "ok", "verdict": "pass", "anomalies": []}).to_string();
    json!({"id": id, "choices": [{"index": 0, "message": {"role": "assistant", "content": content}}]}).to_string()
}
fn digest_for(req: &str, body: &str) -> [u8; 32] {
    let resp = hex::encode(near_sdk::env::sha256_array(body.as_bytes()));
    eip191_digest(&format!("{MODEL}:{req}:{resp}"))
}
/// r || s || v as 65 bytes, v = recovery id + 27. k256 signs with low s.
fn sign_raw(key: &SigningKey, digest: &[u8; 32]) -> [u8; 65] {
    let (sig, rec) = key.sign_prehash_recoverable(digest).unwrap();
    let mut out = [0u8; 65];
    out[..64].copy_from_slice(&sig.to_bytes());
    out[64] = rec.to_byte() + 27;
    out
}
fn hex_sig(b: &[u8; 65]) -> String { format!("0x{}", hex::encode(b)) }
/// n - x for a 32-byte big-endian x < n.
fn n_minus(x: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let mut d = N[i] as i16 - x[i] as i16 - borrow;
        borrow = if d < 0 { d += 256; 1 } else { 0 };
        out[i] = d as u8;
    }
    out
}

const REQ: &str = "c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1";

/// Submit with the given signature; Ok(verdict) or Err(panic message).
fn try_submit(r: &mut Registry, loan: &str, body: &str, sig: &str, at: u64) -> Result<String, String> {
    ctx_at(&servicer(), at, 1);
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        r.submit_verdict(loan.to_string(), MODEL.into(), REQ.into(), body.to_string(), sig.to_string()).verdict
    }));
    res.map_err(|e| e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default())
}

/// A fresh registry and a fresh, never-submitted reply; the signature is edited by `edit` before submitting.
fn submit_edited(edit: impl Fn(&mut [u8; 65])) -> Result<String, String> {
    let (mut r, key, loan) = setup();
    let body = body_for(&loan, T + 86_400_000, "chatcmpl-redteam");
    let mut sig = sign_raw(&key, &digest_for(REQ, &body));
    edit(&mut sig);
    try_submit(&mut r, &loan, &body, &hex_sig(&sig), T + 1)
}

#[test]
fn the_unedited_signature_is_accepted() {
    assert_eq!(submit_edited(|_| {}), Ok("pass".to_string()));
}

#[test]
fn r_or_s_equal_to_zero_is_refused() {
    assert_eq!(submit_edited(|s| s[..32].fill(0)), Err("bad signature".into()));
    assert_eq!(submit_edited(|s| s[32..64].fill(0)), Err("bad signature".into()));
}

#[test]
fn r_or_s_at_or_above_the_group_order_is_refused() {
    for edit in [
        (|s: &mut [u8; 65]| s[..32].copy_from_slice(&N)) as fn(&mut [u8; 65]),
        |s| s[32..64].copy_from_slice(&N),
        |s| s[..32].fill(0xff),
        |s| s[32..64].fill(0xff),
    ] {
        assert_eq!(submit_edited(edit), Err("bad signature".into()));
    }
}

#[test]
fn v_values_other_than_0_1_27_28_are_refused() {
    for v in [2u8, 3, 29] {
        assert_eq!(submit_edited(|s| s[64] = v), Err("bad signature".into()), "v = {v}");
    }
}

#[test]
fn v_0_and_v_27_are_the_same_signature_and_the_second_use_is_a_replay() {
    let (mut r, key, loan) = setup();
    let body = body_for(&loan, T + 86_400_000, "chatcmpl-v-forms");
    let sig = sign_raw(&key, &digest_for(REQ, &body));
    let mut low = sig;
    low[64] -= 27;
    // v = 0 or 1 is accepted on a fresh response
    assert_eq!(try_submit(&mut r, &loan, &body, &hex_sig(&low), T + 1), Ok("pass".into()));
    // the same signature written with v = 27 or 28 does not count again
    assert_eq!(try_submit(&mut r, &loan, &body, &hex_sig(&sig), T + 2), Err("this signed response was already submitted".into()));
    // and the other order, in a fresh registry and for a fresh loan
    let (mut r, key, loan) = setup();
    let body = body_for(&loan, T + 86_400_000, "chatcmpl-v-forms");
    let sig = sign_raw(&key, &digest_for(REQ, &body));
    let mut low = sig;
    low[64] -= 27;
    assert_eq!(try_submit(&mut r, &loan, &body, &hex_sig(&sig), T + 1), Ok("pass".into()));
    assert_eq!(try_submit(&mut r, &loan, &body, &hex_sig(&low), T + 2), Err("this signed response was already submitted".into()));
}

#[test]
fn a_high_s_signature_on_a_fresh_response_is_refused() {
    // (r, n - s) with the recovery id flipped recovers the same key in plain ECDSA; the contract asks ecrecover to
    // refuse it (malleability flag), so it is not a second valid signature for a response never submitted.
    let res = submit_edited(|s| {
        let high = n_minus(&s[32..64]);
        s[32..64].copy_from_slice(&high);
        s[64] = if s[64] == 27 { 28 } else { 27 };
    });
    assert_eq!(res, Err("bad signature".into()));
    // the same edit is also refused straight at recover_address
    ctx_at(&servicer(), T, 0);
    let (key, addr) = test_tee();
    let d = digest_for(REQ, "x");
    let mut sig = sign_raw(&key, &d);
    assert_eq!(recover_address(&d, &hex_sig(&sig)), Some(addr));
    let high = n_minus(&sig[32..64]);
    sig[32..64].copy_from_slice(&high);
    sig[64] = if sig[64] == 27 { 28 } else { 27 };
    assert_eq!(recover_address(&d, &hex_sig(&sig)), None);
}

/// A signed clean reply padded through the outer `id` to exactly `len` bytes.
fn padded(len: usize) -> (Registry, String, String, String) {
    let (r, key, loan) = setup();
    let short = body_for(&loan, T + 86_400_000, "");
    let body = body_for(&loan, T + 86_400_000, &"p".repeat(len - short.len()));
    assert_eq!(body.len(), len);
    let sig = hex_sig(&sign_raw(&key, &digest_for(REQ, &body)));
    (r, loan, body, sig)
}

#[test]
fn a_4097_byte_body_is_refused_and_4096_bytes_is_accepted() {
    let (mut r, loan, body, sig) = padded(4097);
    assert_eq!(try_submit(&mut r, &loan, &body, &sig, T + 1), Err("response_body too long".into()));
    let (mut r, loan, body, sig) = padded(4096);
    assert_eq!(try_submit(&mut r, &loan, &body, &sig, T + 1), Ok("pass".into()));
}

#[test]
fn expiry_equal_to_the_block_time_is_accepted_and_one_ms_later_is_refused() {
    let (mut r, key, loan) = setup();
    let at = T + 5_000;
    let body = body_for(&loan, at, "chatcmpl-expiry-equal");
    let sig = hex_sig(&sign_raw(&key, &digest_for(REQ, &body)));
    assert_eq!(try_submit(&mut r, &loan, &body, &sig, at), Ok("pass".into()));
    let (mut r, key, loan) = setup();
    let body = body_for(&loan, at, "chatcmpl-expiry-plus-1");
    let sig = hex_sig(&sign_raw(&key, &digest_for(REQ, &body)));
    assert_eq!(try_submit(&mut r, &loan, &body, &sig, at + 1), Err("verdict expired".into()));
}
