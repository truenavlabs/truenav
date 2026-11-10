//! Append-only proof locators. Quote verification is exclusively off chain.
use crate::*;
use near_sdk::json_types::U64;
const ATTESTER_KEY: &[u8] = b"truenav:v3:attestations:writer";
pub const PROOF_SCHEME: &str = "outlayer_tdx_v1";
pub const MAX_ATTESTATIONS_PER_RECEIPT: u64 = 12;
pub const MAX_ATTESTATIONS_PER_ATTESTER: u64 = 3;
#[near(serializers=[borsh,json])]
#[derive(Clone, Debug, PartialEq)]
pub struct BodyBinding {
    pub token_id: String,
    pub seq: U64,
    pub receipt_sha256: String,
    pub body_sha256: String,
}
#[near(serializers=[borsh,json])]
#[derive(Clone, Debug, PartialEq)]
pub struct AttestationRecord {
    pub token_id: String,
    pub seq: U64,
    pub receipt_sha256: String,
    pub body_sha256: String,
    pub proof_ref: String,
    pub proof_scheme: String,
    pub attester: AccountId,
    pub block_height: U64,
}
fn is_hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn identity(token: &str, seq: u64, sha: &str, proof: Option<&str>) -> Vec<u8> {
    let mut b = Vec::new();
    for part in [token.as_bytes(), &seq.to_be_bytes(), sha.as_bytes()] {
        truenav_v3_core::source::lp(&mut b, part).expect("bounded identity");
    }
    if let Some(p) = proof {
        truenav_v3_core::source::lp(&mut b, p.as_bytes()).expect("bounded locator");
    }
    env::sha256(&b)
}
fn storage_key(prefix: &[u8], identity: &[u8]) -> Vec<u8> {
    [b"truenav:v3:attestations:".as_slice(), prefix, identity].concat()
}
fn body_key(token: &str, seq: u64, sha: &str) -> Vec<u8> {
    storage_key(b"body:", &identity(token, seq, sha, None))
}
fn read<T: BorshDeserialize>(key: &[u8]) -> Option<T> {
    let raw = env::storage_read(key)?;
    borsh::from_slice(&raw).ok()
}
/// Like `read`, but corrupt bytes are an error instead of "absent". Used on the write path, so corrupt
/// attestation state fails closed (with a refund) instead of being overwritten.
fn read_strict<T: BorshDeserialize>(key: &[u8]) -> Result<Option<T>, ()> {
    match env::storage_read(key) {
        None => Ok(None),
        Some(raw) => borsh::from_slice(&raw).map(Some).map_err(|_| ()),
    }
}
fn put<T: BorshSerialize>(key: &[u8], v: &T) {
    let Ok(bytes) = borsh::to_vec(v) else {
        return;
    };
    env::storage_write(key, &bytes);
}
/// Fixed public testnet API routes only. No query, credentials, fragment, port, redirect or alternate origin.
pub fn normalize_proof_ref(p: &str) -> Option<String> {
    if p.len() > 256 {
        return None;
    }
    let tail = p.strip_prefix("https://testnet-api.outlayer.ai/attestations/by-request/")?;
    let tail = tail.strip_suffix('/').unwrap_or(tail);
    if tail.is_empty() || !tail.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let id = tail.parse::<u64>().ok()?;
    Some(format!(
        "https://testnet-api.outlayer.ai/attestations/by-request/{id}"
    ))
}
pub fn valid_proof_ref(p: &str) -> bool {
    normalize_proof_ref(p).as_deref() == Some(p)
}
pub(crate) fn bind_body(
    token: &str,
    seq: u64,
    receipt_sha: &str,
    body_sha: &str,
) -> Result<(), &'static str> {
    let mut framed = Vec::new();
    for part in [token.as_bytes(), &seq.to_be_bytes(), receipt_sha.as_bytes()] {
        truenav_v3_core::source::lp(&mut framed, part).map_err(|_| "v3_body_identity")?;
    }
    let k = storage_key(b"body:", &env::sha256(&framed));
    if env::storage_has_key(&k) {
        return Err("v3_body_binding_exists");
    }
    let bytes = borsh::to_vec(&BodyBinding {
        token_id: token.into(),
        seq: U64(seq),
        receipt_sha256: receipt_sha.into(),
        body_sha256: body_sha.into(),
    })
    .map_err(|_| "v3_body_serialization")?;
    env::storage_write(&k, &bytes);
    Ok(())
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PublishResult {
    pub record: Option<AttestationRecord>,
    pub error: Option<String>,
}
impl PublishResult {
    fn ok(record: AttestationRecord) -> Self {
        Self {
            record: Some(record),
            error: None,
        }
    }
    fn error(code: &'static str) -> Self {
        Self {
            record: None,
            error: Some(code.into()),
        }
    }
}
fn refund(to: AccountId, amount: u128) {
    if amount > 0 {
        Promise::new(to)
            .transfer(NearToken::from_yoctonear(amount))
            .detach();
    }
}
#[near]
impl Receipts {
    /// Writer rotation affects future submissions only. Historical records are immutable.
    #[payable]
    pub fn set_attester(&mut self, account: Option<AccountId>) {
        self.only_admin();
        require!(self.paused, "pause before writer rotation");
        match account {
            Some(a) => put(ATTESTER_KEY, &a),
            None => {
                env::storage_remove(ATTESTER_KEY);
            }
        }
    }
    pub fn get_attester(&self) -> Option<AccountId> {
        read(ATTESTER_KEY)
    }
    pub fn get_body_binding(&self, token_id: String, seq: U64) -> Option<BodyBinding> {
        let r = self.receipts.get(&(token_id.clone(), seq.0))?;
        if !truenav_v3_core::wire::is_v3_method(&r.method) {
            return None;
        }
        let id = serde_json::from_str::<Value>(&r.receipt)
            .ok()
            .and_then(|v| v.get("receipt_sha256").and_then(|x| x.as_str().map(str::to_string)))
            .unwrap_or_else(|| r.receipt_sha256.clone());
        read(&body_key(&token_id, seq.0, &id))
    }
    #[payable]
    pub fn publish_attestation(
        &mut self,
        token_id: String,
        seq: U64,
        receipt_sha256: String,
        body_sha256: String,
        proof_ref: String,
        proof_scheme: String,
    ) -> PublishResult {
        let writer = env::predecessor_account_id();
        require!(
            self.get_attester().as_ref() == Some(&writer),
            "attester only"
        );
        require!(!self.paused, "paused");
        let attached = env::attached_deposit().as_yoctonear();
        require!(attached > 0, "storage deposit required");
        require!(
            token_id.len() <= 128 && is_hash(&receipt_sha256) && is_hash(&body_sha256),
            "invalid binding"
        );
        let proof_ref = normalize_proof_ref(&proof_ref).expect("unsupported proof reference");
        require!(
            proof_scheme == PROOF_SCHEME && valid_proof_ref(&proof_ref),
            "unsupported proof reference or scheme"
        );
        let binding = self
            .get_body_binding(token_id.clone(), seq)
            .expect("v3 body binding required");
        require!(
            binding.receipt_sha256 == receipt_sha256 && binding.body_sha256 == body_sha256,
            "attestation binding mismatch"
        );
        let id = identity(&token_id, seq.0, &receipt_sha256, None);
        let record_key = storage_key(
            b"record:",
            &identity(&token_id, seq.0, &receipt_sha256, Some(&proof_ref)),
        );
        let Ok(existing) = read_strict::<AttestationRecord>(&record_key) else {
            refund(writer, attached);
            return PublishResult::error("attestation_state_corrupt");
        };
        if let Some(existing) = existing {
            require!(
                existing.token_id == token_id
                    && existing.seq == seq
                    && existing.receipt_sha256 == receipt_sha256
                    && existing.body_sha256 == body_sha256
                    && existing.proof_ref == proof_ref
                    && existing.proof_scheme == proof_scheme,
                "attestation record immutable"
            );
            refund(writer, attached);
            return PublishResult::ok(existing);
        }
        let count_key = storage_key(b"count:", &id);
        let Ok(count) = read_strict::<u64>(&count_key) else {
            refund(writer, attached);
            return PublishResult::error("attestation_state_corrupt");
        };
        let count = count.unwrap_or(0);
        if count >= MAX_ATTESTATIONS_PER_RECEIPT {
            refund(writer, attached);
            return PublishResult::error("attestation record limit reached");
        }
        let mut written_by_current = 0u64;
        for i in 0..count {
            let mut indexed = id.clone();
            indexed.extend_from_slice(&i.to_be_bytes());
            let Some(k) = env::storage_read(&storage_key(b"item:", &indexed)) else {
                refund(writer.clone(), attached);
                return PublishResult::error("attestation_index_missing");
            };
            let Some(record) = read::<AttestationRecord>(&k) else {
                refund(writer.clone(), attached);
                return PublishResult::error("attestation_record_missing");
            };
            if record.attester == writer {
                written_by_current += 1;
            }
        }
        if written_by_current >= MAX_ATTESTATIONS_PER_ATTESTER {
            refund(writer, attached);
            return PublishResult::error("attestation record limit reached");
        }
        let next = count + 1;
        let mut indexed = id.clone();
        indexed.extend_from_slice(&count.to_be_bytes());
        let index_key = storage_key(b"item:", &indexed);
        let record = AttestationRecord {
            token_id,
            seq,
            receipt_sha256,
            body_sha256,
            proof_ref,
            proof_scheme,
            attester: writer.clone(),
            block_height: U64(env::block_height()),
        };
        let bytes = borsh::to_vec(&record).expect("record serialization");
        // Preflight a conservative overhead allowance before writing, then refund to actual measured storage.
        let maximum_bytes = record_key.len()
            + bytes.len()
            + count_key.len()
            + 8
            + index_key.len()
            + record_key.len()
            + 3 * 128;
        let maximum_cost = maximum_bytes as u128 * env::storage_byte_cost().as_yoctonear();
        require!(attached >= maximum_cost, "storage deposit too small");
        let before = env::storage_usage();
        env::storage_write(&record_key, &bytes);
        put(&count_key, &next);
        env::storage_write(&index_key, &record_key);
        let actual = env::storage_usage().saturating_sub(before) as u128
            * env::storage_byte_cost().as_yoctonear();
        require!(actual <= maximum_cost, "storage overhead changed");
        refund(writer, attached - actual);
        emit(
            "attestation_recorded",
            json!({"token_id":record.token_id,"seq":record.seq,"receipt_sha256":record.receipt_sha256,"body_sha256":record.body_sha256,"proof_ref":record.proof_ref,"proof_scheme":record.proof_scheme,"attester":record.attester,"block_height":record.block_height}),
        );
        PublishResult::ok(record)
    }
    pub fn get_attestations(
        &self,
        token_id: String,
        seq: U64,
        from: Option<U64>,
        limit: Option<u32>,
    ) -> Vec<AttestationRecord> {
        let Some(binding) = self.get_body_binding(token_id.clone(), seq) else {
            return vec![];
        };
        let id = identity(&token_id, seq.0, &binding.receipt_sha256, None);
        let count = read::<u64>(&storage_key(b"count:", &id)).unwrap_or(0);
        let start = from.map(|n| n.0).unwrap_or(0).min(count);
        let end = start
            .saturating_add(limit.unwrap_or(20).min(100) as u64)
            .min(count);
        let mut out = Vec::new();
        for i in start..end {
            let mut indexed = id.clone();
            indexed.extend_from_slice(&i.to_be_bytes());
            let Some(k) = env::storage_read(&storage_key(b"item:", &indexed)) else {
                break;
            };
            let Some(record) = read::<AttestationRecord>(&k) else {
                break;
            };
            out.push(record);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::{test_utils::VMContextBuilder, testing_env};
    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }
    fn ctx(who: &str, deposit: u128, height: u64) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(acc("receipts.tnlab-718ca9.testnet"))
            .predecessor_account_id(acc(who))
            .signer_account_id(acc(who))
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .block_height(height)
            .prepaid_gas(Gas::from_tgas(300))
            .account_balance(NearToken::from_near(100));
        testing_env!(b.build());
    }
    fn setup() -> (Receipts, Value, BodyBinding) {
        ctx("admin.testnet", 1, 1);
        let mut c = Receipts::new(
            acc("admin.testnet"),
            acc("pauser.testnet"),
            Config {
                outlayer: acc("outlayer.testnet"),
                project_id: "TEST".into(),
                version_key: "0".repeat(64),
                method: "cashflow-v2.1.0".into(),
                secrets_profile: "TEST".into(),
                secrets_owner: acc("admin.testnet"),
                max_instructions: 10000000000,
                max_memory_mb: 128,
                max_execution_seconds: 180,
                outlayer_deposit: U128(0),
                storage_deposit: U128(NearToken::from_near(1).as_yoctonear()),
                outlayer_tgas: 200,
                callback_tgas: 80,
            },
        );
        assert!(c.get_attester().is_none());
        c.pause();
        c.set_attester(Some(acc("relayer.testnet")));
        c.unpause();
        let g: Value =
            serde_json::from_str(include_str!("../../schema/vectors/receipt-v3-golden.json"))
                .unwrap();
        let e = g["vectors"][0]["envelope"].clone();
        let token = e["token_id"].as_str().unwrap().to_string();
        let sha = e["receipt_sha256"].as_str().unwrap().to_string();
        let mut b = e.clone();
        for k in ["issued_at", "attestation_ref", "receipt_sha256"] {
            b.as_object_mut().unwrap().remove(k);
        }
        let body = truenav_v3_core::hash(truenav_v3_core::canonical(&b).unwrap().as_bytes());
        c.tokens.insert(
            token.clone(),
            TokenInfo {
                token_id: token.clone(),
                kind: "credit".into(),
                receipts: 1,
                registered_ns: 0,
            },
        );
        c.receipts.insert(
            (token.clone(), 1),
            StoredReceipt {
                token_id: token.clone(),
                seq: 1,
                request_id: 1,
                method: "truenav-v3.0.0".into(),
                version_key: "0".repeat(64),
                score: 99,
                band: "green".into(),
                period: "2026-10".into(),
                as_of: "2026-11-10T12:00:00Z".into(),
                caps: vec![],
                holds: vec![],
                receipt_sha256: sha.clone(),
                receipt: truenav_v3_core::canonical(&e).unwrap(),
                requested_ns: 0,
                stored_ns: 0,
                block_height: 1,
            },
        );
        bind_body(&token, 1, &sha, &body).unwrap();
        let binding = c.get_body_binding(token, U64(1)).unwrap();
        (c, e, binding)
    }
    fn reference(n: u64) -> String {
        format!("https://testnet-api.outlayer.ai/attestations/by-request/{n}")
    }
    fn publish(c: &mut Receipts, b: &BodyBinding, n: u64) -> AttestationRecord {
        let out = c.publish_attestation(
            b.token_id.clone(),
            b.seq,
            b.receipt_sha256.clone(),
            b.body_sha256.clone(),
            reference(n),
            PROOF_SCHEME.into(),
        );
        assert!(out.error.is_none(), "{:?}", out.error);
        out.record.expect("attestation record")
    }
    fn fails(f: impl FnOnce()) {
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).is_err());
    }
    #[test]
    fn default_writer_is_closed_and_only_admin_can_configure_while_paused() {
        let (mut c, _, b) = setup();
        ctx("attacker.testnet", 1, 2);
        fails(|| c.set_attester(Some(acc("attacker.testnet"))));
        ctx("admin.testnet", 1, 3);
        fails(|| c.set_attester(None));
        c.pause();
        c.set_attester(None);
        assert!(c.get_attester().is_none());
        c.unpause();
        ctx("relayer.testnet", NearToken::from_near(1).as_yoctonear(), 4);
        fails(|| {
            publish(&mut c, &b, 1);
        });
        assert!(c.get_attestations(b.token_id, b.seq, None, None).is_empty());
    }
    #[test]
    fn non_attester_cannot_occupy_a_proof_slot() {
        let (mut c, _, b) = setup();
        ctx(
            "attacker.testnet",
            NearToken::from_near(1).as_yoctonear(),
            2,
        );
        let before = env::storage_usage();
        fails(|| {
            publish(&mut c, &b, 1);
        });
        assert_eq!(before, env::storage_usage());
        assert!(c.get_attestations(b.token_id, b.seq, None, None).is_empty());
    }
    #[test]
    fn append_only_metadata_never_changes_the_frozen_receipt() {
        let (mut c, e, b) = setup();
        let original = c.receipts.get(&(b.token_id.clone(), 1)).unwrap().clone();
        ctx("relayer.testnet", NearToken::from_near(1).as_yoctonear(), 5);
        let r = publish(&mut c, &b, 1);
        assert_eq!(r.block_height, U64(5));
        assert_eq!(r.attester, acc("relayer.testnet"));
        assert_eq!(c.get_receipt(b.token_id.clone(), 1).unwrap(), e);
        assert_eq!(*c.receipts.get(&(b.token_id.clone(), 1)).unwrap(), original);
        assert!(e["attestation_ref"].is_null());
        assert_eq!(c.get_attestations(b.token_id, b.seq, None, None), vec![r]);
    }
    #[test]
    fn zero_or_insufficient_storage_deposit_writes_nothing() {
        let (mut c, _, b) = setup();
        for amount in [0, 1] {
            ctx("relayer.testnet", amount, 5);
            let before = env::storage_usage();
            fails(|| {
                publish(&mut c, &b, 1);
            });
            assert_eq!(before, env::storage_usage());
        }
        assert!(c.get_attestations(b.token_id, b.seq, None, None).is_empty());
    }
    #[test]
    fn exact_resubmit_returns_the_original_without_new_storage_or_height() {
        let (mut c, _, b) = setup();
        ctx("relayer.testnet", NearToken::from_near(1).as_yoctonear(), 5);
        let first = publish(&mut c, &b, 1);
        ctx("relayer.testnet", 1, 999);
        let before = env::storage_usage();
        assert_eq!(publish(&mut c, &b, 1), first);
        assert_eq!(before, env::storage_usage());
        assert_eq!(c.get_attestations(b.token_id, b.seq, None, None).len(), 1);
    }
    #[test]
    fn at_most_three_proofs_but_retries_remain_idempotent() {
        let (mut c, _, b) = setup();
        ctx("relayer.testnet", NearToken::from_near(1).as_yoctonear(), 4);
        let first = publish(&mut c, &b, 1);
        publish(&mut c, &b, 2);
        publish(&mut c, &b, 3);
        let before = env::storage_usage();
        fails(|| {
            publish(&mut c, &b, 4);
        });
        assert_eq!(env::storage_usage(), before);
        assert_eq!(publish(&mut c, &b, 1), first);
        assert_eq!(c.get_attestations(b.token_id, b.seq, None, None).len(), 3);
    }
    #[test]
    fn rotated_attester_has_its_own_three_record_budget() {
        let (mut c,_,b)=setup();ctx("relayer.testnet",NearToken::from_near(1).as_yoctonear(),4);
        for n in 1..=3 {publish(&mut c,&b,n);}
        ctx("admin.testnet",1,5);c.pause();c.set_attester(Some(acc("new-relayer.testnet")));c.unpause();
        ctx("new-relayer.testnet",NearToken::from_near(1).as_yoctonear(),6);
        for n in 4..=6 {publish(&mut c,&b,n);}
        fails(||{publish(&mut c,&b,7);});
        assert_eq!(c.get_attestations(b.token_id,b.seq,None,None).len(),6);
    }
    #[test]
    fn different_proofs_append_and_cannot_overwrite_each_other() {
        let (mut c, _, b) = setup();
        ctx("relayer.testnet", NearToken::from_near(1).as_yoctonear(), 5);
        let a = publish(&mut c, &b, 1);
        ctx("relayer.testnet", NearToken::from_near(1).as_yoctonear(), 6);
        let z = publish(&mut c, &b, 2);
        assert_ne!(a.proof_ref, z.proof_ref);
        assert_eq!(
            c.get_attestations(b.token_id.clone(), b.seq, None, None),
            vec![a.clone(), z.clone()]
        );
        assert_eq!(
            c.get_attestations(b.token_id, b.seq, Some(U64(1)), Some(1)),
            vec![z]
        );
    }
    #[test]
    fn hashes_token_and_sequence_are_bound_to_the_callback() {
        let (mut c, _, b) = setup();
        for change in ["receipt", "body", "token", "seq"] {
            ctx("relayer.testnet", NearToken::from_near(1).as_yoctonear(), 5);
            let mut altered = b.clone();
            match change {
                "receipt" => altered.receipt_sha256 = "a".repeat(64),
                "body" => altered.body_sha256 = "b".repeat(64),
                "token" => altered.token_id = "wrong-fund".into(),
                _ => altered.seq = U64(2),
            }
            fails(|| {
                publish(&mut c, &altered, 1);
            });
        }
        assert!(c.get_attestations(b.token_id, b.seq, None, None).is_empty());
    }
    #[test]
    fn pause_and_rotation_preserve_old_records() {
        let (mut c, _, b) = setup();
        ctx("relayer.testnet", NearToken::from_near(1).as_yoctonear(), 5);
        let original = publish(&mut c, &b, 1);
        ctx("admin.testnet", 1, 6);
        c.pause();
        c.set_attester(Some(acc("next-relayer.testnet")));
        ctx(
            "next-relayer.testnet",
            NearToken::from_near(1).as_yoctonear(),
            7,
        );
        fails(|| {
            publish(&mut c, &b, 2);
        });
        ctx("admin.testnet", 1, 8);
        c.unpause();
        ctx("relayer.testnet", NearToken::from_near(1).as_yoctonear(), 9);
        fails(|| {
            publish(&mut c, &b, 2);
        });
        ctx(
            "next-relayer.testnet",
            NearToken::from_near(1).as_yoctonear(),
            10,
        );
        let next = publish(&mut c, &b, 2);
        assert_eq!(next.attester, acc("next-relayer.testnet"));
        assert_eq!(
            c.get_attestations(b.token_id, b.seq, None, None),
            vec![original, next]
        );
    }
    #[test]
    fn proof_locator_cannot_select_mainnet_another_host_or_credentials() {
        for bad in [
            "http://testnet-api.outlayer.ai/attestations/by-request/1",
            "https://api.outlayer.ai/attestations/by-request/1",
            "https://testnet-api.outlayer.ai.evil.invalid/attestations/by-request/1",
            "https://testnet-api.outlayer.ai/attestations/by-request/01",
            "https://testnet-api.outlayer.ai/attestations/by-request/1?token=none",
            "https://testnet-api.outlayer.ai/attestations/by-request/1#other",
            "https://testnet-api.outlayer.ai/attestations/by-request/../1",
        ] {
            assert!(!valid_proof_ref(bad));
        }
        assert!(valid_proof_ref(&reference(1)));
        assert!(!valid_proof_ref("https://testnet-api.outlayer.ai/attestations/by-call/018c52cc-8269-43a8-8f19-f67d6a6bb618"));
    }
    #[test]
    fn writer_pays_measured_storage_and_exact_retries_refund_the_whole_deposit() {
        use near_sdk::{mock::MockAction, test_utils::get_created_receipts};
        let (mut c, _, binding) = setup();
        let attached = NearToken::from_near(1).as_yoctonear();
        ctx("relayer.testnet", attached, 5);
        let before = env::storage_usage();
        publish(&mut c, &binding, 1);
        let cost =
            (env::storage_usage() - before) as u128 * env::storage_byte_cost().as_yoctonear();
        let refunded: u128 = get_created_receipts()
            .into_iter()
            .flat_map(|r| r.actions)
            .filter_map(|a| {
                if let MockAction::Transfer { deposit, .. } = a {
                    Some(deposit.as_yoctonear())
                } else {
                    None
                }
            })
            .sum();
        assert_eq!(refunded, attached - cost);
        assert!(cost > 0);
        ctx("relayer.testnet", 1, 9);
        publish(&mut c, &binding, 1);
        let refunded: u128 = get_created_receipts()
            .into_iter()
            .flat_map(|r| r.actions)
            .filter_map(|a| {
                if let MockAction::Transfer { deposit, .. } = a {
                    Some(deposit.as_yoctonear())
                } else {
                    None
                }
            })
            .sum();
        assert_eq!(refunded, 1);
    }
    #[test]
    fn redteam_r1_rotation_cannot_exceed_three_records_per_receipt() {
        let (mut c, _, b) = setup();
        ctx("relayer.testnet", NearToken::from_near(1).as_yoctonear(), 4);
        for n in 1..=3 {
            publish(&mut c, &b, n);
        }
        ctx("admin.testnet", 1, 5);
        c.pause();
        c.set_attester(Some(acc("new-relayer.testnet")));
        c.unpause();
        ctx("new-relayer.testnet", NearToken::from_near(1).as_yoctonear(), 6);
        publish(&mut c, &b, 4);
        ctx("admin.testnet", 1, 7);
        c.pause();
        c.set_attester(Some(acc("relayer.testnet")));
        c.unpause();
        ctx("relayer.testnet", NearToken::from_near(1).as_yoctonear(), 8);
        let again = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let out = c.publish_attestation(
                b.token_id.clone(),
                b.seq,
                b.receipt_sha256.clone(),
                b.body_sha256.clone(),
                reference(8),
                PROOF_SCHEME.into(),
            );
            assert!(out.error.is_some(), "the original attester received a fresh budget");
        }));
        assert!(again.is_ok());
        assert!(c.get_attestations(b.token_id.clone(), b.seq, None, None).len() <= MAX_ATTESTATIONS_PER_RECEIPT as usize);
    }
    fn transfers() -> u128 {
        use near_sdk::{mock::MockAction, test_utils::get_created_receipts};
        get_created_receipts()
            .into_iter()
            .flat_map(|r| r.actions)
            .filter_map(|a| match a {
                MockAction::Transfer { deposit, .. } => Some(deposit.as_yoctonear()),
                _ => None,
            })
            .sum()
    }
    fn try_publish(c: &mut Receipts, b: &BodyBinding, n: u64) -> PublishResult {
        c.publish_attestation(
            b.token_id.clone(),
            b.seq,
            b.receipt_sha256.clone(),
            b.body_sha256.clone(),
            reference(n),
            PROOF_SCHEME.into(),
        )
    }
    fn item_key(b: &BodyBinding, i: u64) -> Vec<u8> {
        let mut indexed = identity(&b.token_id, b.seq.0, &b.receipt_sha256, None);
        indexed.extend_from_slice(&i.to_be_bytes());
        storage_key(b"item:", &indexed)
    }
    fn count_key(b: &BodyBinding) -> Vec<u8> {
        storage_key(
            b"count:",
            &identity(&b.token_id, b.seq.0, &b.receipt_sha256, None),
        )
    }
    fn record_key(b: &BodyBinding, n: u64) -> Vec<u8> {
        storage_key(
            b"record:",
            &identity(&b.token_id, b.seq.0, &b.receipt_sha256, Some(&reference(n))),
        )
    }
    /// Each error return refunds the whole deposit and writes nothing.
    fn assert_refused_with_full_refund(c: &mut Receipts, b: &BodyBinding, n: u64, code: &str) {
        let attached = NearToken::from_near(1).as_yoctonear();
        ctx("relayer.testnet", attached, 50);
        let before = env::storage_usage();
        let out = try_publish(c, b, n);
        assert_eq!(out.error.as_deref(), Some(code));
        assert!(out.record.is_none());
        assert_eq!(env::storage_usage(), before, "{code}: nothing written");
        assert_eq!(transfers(), attached, "{code}: whole deposit refunded");
    }
    // One case per test: the mocked storage carries over between setup() calls in one test.
    #[test]
    fn fix13_per_attester_limit_refunds_the_whole_deposit() {
        let (mut c, _, b) = setup();
        ctx("relayer.testnet", NearToken::from_near(1).as_yoctonear(), 4);
        for n in 1..=3 {
            publish(&mut c, &b, n);
        }
        assert_refused_with_full_refund(&mut c, &b, 4, "attestation record limit reached");
    }
    #[test]
    fn fix13_per_receipt_limit_refunds_the_whole_deposit() {
        let (mut c, _, b) = setup();
        put(&count_key(&b), &MAX_ATTESTATIONS_PER_RECEIPT);
        assert_refused_with_full_refund(&mut c, &b, 1, "attestation record limit reached");
    }
    #[test]
    fn fix13_missing_index_refunds_the_whole_deposit() {
        let (mut c, _, b) = setup();
        ctx("relayer.testnet", NearToken::from_near(1).as_yoctonear(), 4);
        publish(&mut c, &b, 1);
        env::storage_remove(&item_key(&b, 0));
        assert_refused_with_full_refund(&mut c, &b, 2, "attestation_index_missing");
    }
    #[test]
    fn fix13_missing_record_refunds_the_whole_deposit() {
        let (mut c, _, b) = setup();
        ctx("relayer.testnet", NearToken::from_near(1).as_yoctonear(), 4);
        publish(&mut c, &b, 1);
        let k = env::storage_read(&item_key(&b, 0)).unwrap();
        env::storage_remove(&k);
        assert_refused_with_full_refund(&mut c, &b, 2, "attestation_record_missing");
    }
    #[test]
    fn fix13_corrupt_count_fails_closed_and_does_not_overwrite_slot_zero() {
        let (mut c, _, b) = setup();
        ctx("relayer.testnet", NearToken::from_near(1).as_yoctonear(), 4);
        let first = publish(&mut c, &b, 1);
        let slot0 = env::storage_read(&item_key(&b, 0)).unwrap();
        env::storage_write(&count_key(&b), &[1, 2, 3]);
        assert_refused_with_full_refund(&mut c, &b, 2, "attestation_state_corrupt");
        assert_eq!(env::storage_read(&item_key(&b, 0)).unwrap(), slot0);
        assert_eq!(read::<AttestationRecord>(&record_key(&b, 1)), Some(first));
        assert!(read::<AttestationRecord>(&record_key(&b, 2)).is_none());
    }
    #[test]
    fn fix13_corrupt_record_fails_closed_and_is_not_overwritten() {
        let (mut c, _, b) = setup();
        ctx("relayer.testnet", NearToken::from_near(1).as_yoctonear(), 4);
        publish(&mut c, &b, 1);
        env::storage_write(&record_key(&b, 1), &[0xff]);
        assert_refused_with_full_refund(&mut c, &b, 1, "attestation_state_corrupt");
        assert_eq!(env::storage_read(&record_key(&b, 1)).unwrap(), vec![0xff]);
        // reads still treat corrupt bytes as absent (views are unchanged in fix 13)
        assert!(read::<AttestationRecord>(&record_key(&b, 1)).is_none());
    }
    #[test]
    fn redteam_r1_missing_attestation_record_must_not_panic() {
        let (mut c, _, b) = setup();
        ctx("relayer.testnet", NearToken::from_near(1).as_yoctonear(), 5);
        publish(&mut c, &b, 1);
        let id = identity(&b.token_id, b.seq.0, &b.receipt_sha256, None);
        let mut indexed = id.clone();
        indexed.extend_from_slice(&0u64.to_be_bytes());
        let record_key = env::storage_read(&storage_key(b"item:", &indexed)).unwrap();
        env::storage_remove(&record_key);
        let out = c.publish_attestation(
            b.token_id.clone(),
            b.seq,
            b.receipt_sha256.clone(),
            b.body_sha256.clone(),
            reference(2),
            PROOF_SCHEME.into(),
        );
        assert_eq!(out.error.as_deref(), Some("attestation_record_missing"));
        assert!(out.record.is_none());
    }
}

#[cfg(test)]
mod normalization_tests {
    use super::*;
    #[test]
    fn links_have_one_canonical_form() {
        let canonical = "https://testnet-api.outlayer.ai/attestations/by-request/1";
        assert_eq!(
            normalize_proof_ref("https://testnet-api.outlayer.ai/attestations/by-request/0001/"),
            Some(canonical.into())
        );
        assert!(
            normalize_proof_ref("https://testnet-api.outlayer.ai/attestations/by-tx/abc").is_none()
        );
        assert!(normalize_proof_ref(
            "https://testnet-api.outlayer.ai/attestations/by-request/1?x=y"
        )
        .is_none());
    }
}
