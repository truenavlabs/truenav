//! TrueNav test registry (testnet only).
//!
//! What it does:
//! - Signer registry: the admin registers the secp256k1 (Ethereum-style) addresses allowed to sign score
//!   certificates. Addresses rotate, so they are data, never hardcoded.
//! - Fund registry: the admin binds each fund_id to its NEAR account and manager. A certificate is only
//!   accepted for a registered fund_id whose account and manager match, so a fund cannot rename itself to
//!   escape its history (hole 5 in the score engine).
//! - Score certificates: the engine's output is signed off chain (EIP-191 personal_sign over a canonical
//!   message that includes this contract's account id). The contract recovers the signer with
//!   env::ecrecover, checks it is registered, checks signed_at moves forward, and stores the certificate.
//! - Loan pledges: a registered fund pledges a loan by its hash. The first pledge locks the loan and mints a
//!   NEP-171 token to the fund. A later pledge by another fund is refused with "already pledged elsewhere",
//!   counted as a blocked attempt against the attempting fund, and raises an alert for the holder. The
//!   servicer releases the loan on repayment, which burns the token.
//!
//! Limits: everything stored here is public chain state. Alerts and attempt counters do not name the other
//! fund, but they are not private. The sealed registry design (OutLayer TEE) is the private version.

use near_contract_standards::non_fungible_token::metadata::{NFTContractMetadata, NonFungibleTokenMetadataProvider, TokenMetadata, NFT_METADATA_SPEC};
use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
use near_contract_standards::non_fungible_token::events::{NftBurn, NftMint};
use near_contract_standards::non_fungible_token::{NonFungibleToken, Token, TokenId};
use near_sdk::collections::LazyOption;
use near_sdk::store::{IterableMap, IterableSet, LookupMap, LookupSet, Vector};
use near_sdk::json_types::U128;
use near_sdk::{assert_one_yocto, env, near, require, AccountId, BorshStorageKey, PanicOnDefault, PromiseOrValue};

pub const CERT_DOMAIN: &str = "truenav-cert-v1";

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Signers,
    Funds,
    FundByAccount,
    Certs,
    CertHistory { fund_hash: Vec<u8> },
    Locks,
    Attempts,
    AttemptList { fund_hash: Vec<u8> },
    Alerts,
    AlertList { fund_hash: Vec<u8> },
    NftOwners,
    NftMetadata,
    NftEnum,
    NftApprovals,
    ContractMetadata,
    TeeSigners,
    Verdicts,
    VerdictList { loan_hash: Vec<u8> },
    SeenResponses,
}

/// A fund bound to its account and manager by the admin.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Fund {
    pub fund_id: String,
    pub account_id: AccountId,
    pub manager_id: String,
}

/// The fields the engine certifies. Money is in integer cents and scores in hundredths, so the signed
/// message has no floating point.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Certificate {
    pub fund_id: String,
    pub fund_account: AccountId,
    pub manager_id: String,
    /// scored, disclaimed, verification_failed, not_rated or invalid_fund_fields.
    pub status: String,
    /// Rounded TrueNav score 0 to 100, or None when the status has no number.
    pub score: Option<u8>,
    /// green, yellow, red, or empty when there is no number.
    pub band: String,
    /// raw x 100, may be negative.
    pub raw_x100: i64,
    pub true_val_cents: U128,
    pub true_range_cents: U128,
    pub policy_nav_cents: U128,
    pub headline_cents: U128,
    pub blocked_attempts: u32,
    pub data_asof_ms: u64,
    pub signed_at_ms: u64,
    /// Engine git commit that produced the numbers.
    pub engine_commit: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct StoredCertificate {
    pub certificate: Certificate,
    pub signer: String,
    pub stored_at_ms: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Lock {
    pub fund_id: String,
    pub locked_at_ms: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Attempt {
    pub attempt_id: String,
    pub at_ms: u64,
}

/// Result of a pledge. A refusal is a normal return, not a panic, so the attempt counter is kept.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum PledgeOutcome {
    Pledged { token_id: String },
    AlreadyYours { token_id: String },
    Refused { message: String, attempt_id: String },
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct AttemptSummary {
    pub count: u32,
    pub attempts: Vec<Attempt>,
}

/// A TEE signing address the admin registered after checking its attestation off chain (phase 1).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct TeeSigner {
    /// Ethereum-style address of the model-serving TEE key (provider_tee, ecdsa).
    pub address: String,
    /// Canonical model id that the TEE signs into every response signature.
    pub model_id: String,
    /// Where the off-chain attestation check is recorded (e.g. nonce and time).
    pub attestation_ref: String,
    pub registered_at_ms: u64,
}

/// One TEE underwriter verdict for a loan. No document content is stored.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct StoredVerdict {
    pub verdict: String,
    pub anomalies: Vec<String>,
    pub signer: String,
    pub model_id: String,
    pub request_sha256: String,
    pub response_sha256: String,
    pub at_ms: u64,
}

pub const ANOMALY_CODES: [&str; 6] = ["amount_mismatch", "asset_mismatch", "id_mismatch", "injection_attempt", "duplicate_document", "unreadable"];

/// State layout before the TEE verdicts were added (first testnet release), for migrate().
#[near(serializers = [borsh])]
pub struct RegistryV1 {
    admin: AccountId,
    servicer: AccountId,
    signers: IterableSet<String>,
    funds: LookupMap<String, Fund>,
    fund_by_account: LookupMap<AccountId, String>,
    certs: LookupMap<String, Vector<StoredCertificate>>,
    locks: LookupMap<String, Lock>,
    attempts: LookupMap<String, Vector<Attempt>>,
    alerts: LookupMap<String, Vector<u64>>,
    attempt_seq: u64,
    tokens: NonFungibleToken,
    metadata: LazyOption<NFTContractMetadata>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Registry {
    admin: AccountId,
    servicer: AccountId,
    signers: IterableSet<String>,
    funds: LookupMap<String, Fund>,
    fund_by_account: LookupMap<AccountId, String>,
    certs: LookupMap<String, Vector<StoredCertificate>>,
    locks: LookupMap<String, Lock>,
    attempts: LookupMap<String, Vector<Attempt>>,
    alerts: LookupMap<String, Vector<u64>>,
    attempt_seq: u64,
    tokens: NonFungibleToken,
    metadata: LazyOption<NFTContractMetadata>,
    tee_signers: IterableMap<String, TeeSigner>,
    verdicts: LookupMap<String, Vector<StoredVerdict>>,
    seen_responses: LookupSet<String>,
}

fn fund_hash(fund_id: &str) -> Vec<u8> {
    env::sha256(fund_id.as_bytes())
}

fn is_loan_hash(h: &str) -> bool {
    h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

fn norm_address(a: &str) -> String {
    let s = a.strip_prefix("0x").unwrap_or(a).to_ascii_lowercase();
    require!(s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit()), "signer must be a 20-byte hex address");
    format!("0x{s}")
}

fn is_hex64(h: &str) -> bool {
    h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// Read {loan_hash, verdict, anomalies} from the model's reply inside the exact response body.
/// The model writes the loan hash in 8-character groups; spaces are removed before comparing.
pub fn parse_verdict(response_body: &str) -> Option<(String, String, Vec<String>)> {
    let body: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(response_body).ok()?;
    let content = body.get("choices")?.get(0)?.get("message")?.get("content")?.as_str()?.trim();
    let content = content.trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim();
    let v: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(content).ok()?;
    let loan_hash: String = v.get("loan_hash")?.as_str()?.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_ascii_lowercase();
    let verdict = v.get("verdict")?.as_str()?.to_string();
    let anomalies = v.get("anomalies")?.as_array()?.iter().map(|a| a.as_str().map(|x| x.to_string())).collect::<Option<Vec<_>>>()?;
    Some((loan_hash, verdict, anomalies))
}

/// Canonical message signed by the engine. The contract id prevents replay on another deployment.
pub fn canonical_message(contract_id: &str, c: &Certificate) -> String {
    let score = c.score.map(|s| s.to_string()).unwrap_or_default();
    [
        CERT_DOMAIN.to_string(),
        contract_id.to_string(),
        c.fund_id.clone(),
        c.fund_account.to_string(),
        c.manager_id.clone(),
        c.status.clone(),
        score,
        c.band.clone(),
        c.raw_x100.to_string(),
        c.true_val_cents.0.to_string(),
        c.true_range_cents.0.to_string(),
        c.policy_nav_cents.0.to_string(),
        c.headline_cents.0.to_string(),
        c.blocked_attempts.to_string(),
        c.data_asof_ms.to_string(),
        c.signed_at_ms.to_string(),
        c.engine_commit.clone(),
    ]
    .join("|")
}

/// EIP-191 personal_sign digest: keccak256("\x19Ethereum Signed Message:\n" + len + message).
pub fn eip191_digest(message: &str) -> [u8; 32] {
    let mut data = format!("\x19Ethereum Signed Message:\n{}", message.len()).into_bytes();
    data.extend_from_slice(message.as_bytes());
    env::keccak256_array(&data)
}

/// Recover the signer address from a 65-byte r || s || v signature (v is 0, 1, 27 or 28).
pub fn recover_address(digest: &[u8; 32], sig_hex: &str) -> Option<String> {
    let sig = hex::decode(sig_hex.strip_prefix("0x").unwrap_or(sig_hex)).ok()?;
    if sig.len() != 65 {
        return None;
    }
    let v = match sig[64] {
        0 | 27 => 0u8,
        1 | 28 => 1u8,
        _ => return None,
    };
    let rs: [u8; 64] = sig[..64].try_into().ok()?;
    let pubkey = env::ecrecover(digest, &rs, v, true)?;
    let h = env::keccak256_array(pubkey);
    Some(format!("0x{}", hex::encode(&h[12..])))
}

/// Largest page a paged view returns.
pub const PAGE_MAX: u32 = 100;

fn page<T: near_sdk::borsh::BorshSerialize + near_sdk::borsh::BorshDeserialize>(list: &Vector<T>, from_index: u32, limit: u32) -> impl Iterator<Item = &T> {
    let end = from_index.saturating_add(limit.min(PAGE_MAX)).min(list.len());
    (from_index.min(end)..end).filter_map(move |i| list.get(i))
}

const VALID_STATUS: [&str; 5] = ["scored", "disclaimed", "verification_failed", "not_rated", "invalid_fund_fields"];

#[near]
impl Registry {
    #[init]
    pub fn new(admin: AccountId, servicer: AccountId) -> Self {
        let owner = env::current_account_id();
        let metadata = NFTContractMetadata {
            spec: NFT_METADATA_SPEC.to_string(),
            name: "TrueNav loan pledge (testnet demo)".to_string(),
            symbol: "TNPLEDGE".to_string(),
            icon: None,
            base_uri: None,
            reference: None,
            reference_hash: None,
        };
        Self {
            admin,
            servicer,
            signers: IterableSet::new(Key::Signers),
            funds: LookupMap::new(Key::Funds),
            fund_by_account: LookupMap::new(Key::FundByAccount),
            certs: LookupMap::new(Key::Certs),
            locks: LookupMap::new(Key::Locks),
            attempts: LookupMap::new(Key::Attempts),
            alerts: LookupMap::new(Key::Alerts),
            attempt_seq: 0,
            tokens: NonFungibleToken::new(Key::NftOwners, owner, Some(Key::NftMetadata), Some(Key::NftEnum), Some(Key::NftApprovals)),
            metadata: LazyOption::new(Key::ContractMetadata, Some(&metadata)),
            tee_signers: IterableMap::new(Key::TeeSigners),
            verdicts: LookupMap::new(Key::Verdicts),
            seen_responses: LookupSet::new(Key::SeenResponses),
        }
    }

    /// Upgrade a deployment made with the previous state layout. Call once, right after deploying new code.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let old: RegistryV1 = env::state_read().expect("no old state to migrate");
        Self {
            admin: old.admin,
            servicer: old.servicer,
            signers: old.signers,
            funds: old.funds,
            fund_by_account: old.fund_by_account,
            certs: old.certs,
            locks: old.locks,
            attempts: old.attempts,
            alerts: old.alerts,
            attempt_seq: old.attempt_seq,
            tokens: old.tokens,
            metadata: old.metadata,
            tee_signers: IterableMap::new(Key::TeeSigners),
            verdicts: LookupMap::new(Key::Verdicts),
            seen_responses: LookupSet::new(Key::SeenResponses),
        }
    }

    /// Admin only, and the call must carry exactly 1 yoctoNEAR so only a full-access key can make it.
    fn assert_admin(&self) {
        assert_one_yocto();
        require!(env::predecessor_account_id() == self.admin, "admin only");
    }

    // ---------- signer registry ----------

    #[payable]
    pub fn add_signer(&mut self, address: String) {
        self.assert_admin();
        let a = norm_address(&address);
        self.signers.insert(a);
    }

    #[payable]
    pub fn remove_signer(&mut self, address: String) {
        self.assert_admin();
        let a = norm_address(&address);
        self.signers.remove(&a);
    }

    pub fn get_signers(&self) -> Vec<String> {
        self.signers.iter().cloned().collect()
    }

    // ---------- fund registry (binds fund_id) ----------

    #[payable]
    pub fn register_fund(&mut self, fund_id: String, account_id: AccountId, manager_id: String) {
        self.assert_admin();
        require!(!fund_id.is_empty() && fund_id.len() <= 64, "fund_id must be 1 to 64 characters");
        require!(!manager_id.is_empty() && manager_id.len() <= 64, "manager_id must be 1 to 64 characters");
        // The canonical message is pipe-joined, so a pipe inside a field could make two certificates sign alike.
        require!(!fund_id.contains('|') && !manager_id.contains('|'), "fund_id and manager_id must not contain '|'");
        require!(!self.funds.contains_key(&fund_id), "fund_id already registered");
        require!(!self.fund_by_account.contains_key(&account_id), "account already bound to a fund");
        self.fund_by_account.insert(account_id.clone(), fund_id.clone());
        self.funds.insert(fund_id.clone(), Fund { fund_id, account_id, manager_id });
    }

    pub fn get_fund(&self, fund_id: String) -> Option<Fund> {
        self.funds.get(&fund_id).cloned()
    }

    // ---------- score certificates ----------

    /// Verify the engine signature and store the certificate. Panics (and stores nothing) on any failure.
    pub fn submit_certificate(&mut self, certificate: Certificate, signature: String) -> StoredCertificate {
        let c = certificate;
        let fund = self.funds.get(&c.fund_id).cloned();
        require!(fund.is_some(), "fund_id not registered");
        let fund = fund.unwrap();
        require!(c.fund_account == fund.account_id, "fund_account does not match the registered fund");
        require!(c.manager_id == fund.manager_id, "manager_id does not match the registered fund");
        require!(VALID_STATUS.contains(&c.status.as_str()), "unknown status");
        require!(!c.engine_commit.contains('|') && c.engine_commit.len() <= 64, "engine_commit must be at most 64 characters without '|'");
        match c.score {
            Some(s) => {
                require!(c.status == "scored" && s <= 100, "score only for a scored status, 0 to 100");
                require!(["green", "yellow", "red"].contains(&c.band.as_str()), "band must be green, yellow or red");
            }
            None => require!(c.status != "scored" && c.band.is_empty(), "a scored status needs a score"),
        }
        require!(c.data_asof_ms <= c.signed_at_ms, "data_asof after signed_at");
        require!(c.signed_at_ms <= env::block_timestamp_ms() + 10 * 60 * 1000, "signed_at in the future");

        let digest = eip191_digest(&canonical_message(env::current_account_id().as_str(), &c));
        let signer = recover_address(&digest, &signature);
        require!(signer.is_some(), "bad signature");
        let signer = signer.unwrap();
        require!(self.signers.contains(&signer), "signer not registered");

        let fh = fund_hash(&c.fund_id);
        if !self.certs.contains_key(&c.fund_id) {
            self.certs.insert(c.fund_id.clone(), Vector::new(Key::CertHistory { fund_hash: fh }));
        }
        let list = self.certs.get_mut(&c.fund_id).unwrap();
        if let Some(last) = list.get(list.len().saturating_sub(1)) {
            require!(c.signed_at_ms > last.certificate.signed_at_ms, "signed_at must be newer than the last certificate");
        }
        let stored = StoredCertificate { certificate: c, signer, stored_at_ms: env::block_timestamp_ms() };
        list.push(stored.clone());
        stored
    }

    pub fn get_latest_certificate(&self, fund_id: String) -> Option<StoredCertificate> {
        let list = self.certs.get(&fund_id)?;
        list.get(list.len().checked_sub(1)?).cloned()
    }

    /// Signing times of every stored certificate: the engine's cert store for previously_certified.
    pub fn get_certificate_history(&self, fund_id: String) -> Vec<u64> {
        match self.certs.get(&fund_id) {
            Some(list) => list.iter().map(|s| s.certificate.signed_at_ms).collect(),
            None => vec![],
        }
    }

    // ---------- loan pledges and NEP-171 tokens ----------

    /// Pledge a loan by its hash (64 lowercase hex). Only a registered fund's own account may call it.
    #[payable]
    pub fn pledge_loan(&mut self, loan_hash: String, asset_type: String) -> PledgeOutcome {
        assert_one_yocto();
        require!(is_loan_hash(&loan_hash), "loan_hash must be 64 lowercase hex characters");
        require!(asset_type == "real_estate" || asset_type == "invoices", "asset_type must be real_estate or invoices");
        let caller = env::predecessor_account_id();
        let fund_id = self.fund_by_account.get(&caller).cloned();
        require!(fund_id.is_some(), "caller is not a registered fund account");
        let fund_id = fund_id.unwrap();
        let now = env::block_timestamp_ms();

        if let Some(lock) = self.locks.get(&loan_hash).cloned() {
            if lock.fund_id == fund_id {
                return PledgeOutcome::AlreadyYours { token_id: loan_hash };
            }
            self.attempt_seq += 1;
            let attempt_id = format!("attempt-{}", self.attempt_seq);
            let fh = fund_hash(&fund_id);
            if !self.attempts.contains_key(&fund_id) {
                self.attempts.insert(fund_id.clone(), Vector::new(Key::AttemptList { fund_hash: fh }));
            }
            self.attempts.get_mut(&fund_id).unwrap().push(Attempt { attempt_id: attempt_id.clone(), at_ms: now });
            let hh = fund_hash(&lock.fund_id);
            if !self.alerts.contains_key(&lock.fund_id) {
                self.alerts.insert(lock.fund_id.clone(), Vector::new(Key::AlertList { fund_hash: hh }));
            }
            self.alerts.get_mut(&lock.fund_id).unwrap().push(now);
            return PledgeOutcome::Refused { message: "already pledged elsewhere".to_string(), attempt_id };
        }

        self.locks.insert(loan_hash.clone(), Lock { fund_id, locked_at_ms: now });
        let meta = TokenMetadata {
            title: Some("TrueNav loan pledge".to_string()),
            description: None,
            media: None,
            media_hash: None,
            copies: Some(1),
            issued_at: Some(now.to_string()),
            expires_at: None,
            starts_at: None,
            updated_at: None,
            extra: Some(format!("{{\"asset_type\":\"{asset_type}\"}}")),
            reference: None,
            reference_hash: None,
        };
        self.tokens.internal_mint_with_refund(loan_hash.clone(), caller.clone(), Some(meta), None);
        // NEP-171 event so wallets and explorers see the pledge token (owner decision 6 Nov).
        NftMint { owner_id: &caller, token_ids: &[loan_hash.as_str()], memo: None }.emit();
        PledgeOutcome::Pledged { token_id: loan_hash }
    }

    /// Servicer releases a repaid loan: the lock is removed and the token burned.
    #[payable]
    pub fn release_loan(&mut self, loan_hash: String) {
        assert_one_yocto();
        require!(env::predecessor_account_id() == self.servicer, "servicer only");
        require!(self.locks.remove(&loan_hash).is_some(), "loan not pledged");
        let owner = self.tokens.owner_by_id.remove(&loan_hash);
        if let Some(meta) = self.tokens.token_metadata_by_id.as_mut() {
            meta.remove(&loan_hash);
        }
        if let Some(o) = owner.as_ref() {
            let servicer = env::predecessor_account_id();
            NftBurn { owner_id: o, token_ids: &[loan_hash.as_str()], authorized_id: Some(&servicer), memo: None }.emit();
        }
        if let (Some(per_owner), Some(owner)) = (self.tokens.tokens_per_owner.as_mut(), owner) {
            if let Some(mut set) = per_owner.get(&owner) {
                set.remove(&loan_hash);
                if set.is_empty() {
                    per_owner.remove(&owner);
                } else {
                    per_owner.insert(&owner, &set);
                }
            }
        }
    }

    /// Number of certificates stored for a fund.
    pub fn get_certificate_count(&self, fund_id: String) -> u32 {
        self.certs.get(&fund_id).map(|l| l.len()).unwrap_or(0)
    }

    /// One page of certificate signing times, oldest first. Long histories should be read in pages so a
    /// view call never runs out of gas. limit is capped at PAGE_MAX.
    pub fn get_certificate_history_page(&self, fund_id: String, from_index: u32, limit: u32) -> Vec<u64> {
        match self.certs.get(&fund_id) {
            Some(list) => page(list, from_index, limit).map(|s| s.certificate.signed_at_ms).collect(),
            None => vec![],
        }
    }

    pub fn get_lock(&self, loan_hash: String) -> Option<Lock> {
        self.locks.get(&loan_hash).cloned()
    }

    pub fn get_attempts(&self, fund_id: String) -> AttemptSummary {
        match self.attempts.get(&fund_id) {
            Some(list) => AttemptSummary { count: list.len(), attempts: list.iter().cloned().collect() },
            None => AttemptSummary { count: 0, attempts: vec![] },
        }
    }

    /// Times at which another fund tried to pledge one of this fund's loans. The other fund is not named.
    pub fn get_alerts(&self, fund_id: String) -> Vec<u64> {
        match self.alerts.get(&fund_id) {
            Some(list) => list.iter().cloned().collect(),
            None => vec![],
        }
    }

    /// One page of a fund's blocked attempts, oldest first (limit capped at PAGE_MAX).
    pub fn get_attempts_page(&self, fund_id: String, from_index: u32, limit: u32) -> AttemptSummary {
        match self.attempts.get(&fund_id) {
            Some(list) => AttemptSummary { count: list.len(), attempts: page(list, from_index, limit).cloned().collect() },
            None => AttemptSummary { count: 0, attempts: vec![] },
        }
    }

    /// One page of a fund's alert times, oldest first (limit capped at PAGE_MAX).
    pub fn get_alerts_page(&self, fund_id: String, from_index: u32, limit: u32) -> Vec<u64> {
        match self.alerts.get(&fund_id) {
            Some(list) => page(list, from_index, limit).cloned().collect(),
            None => vec![],
        }
    }

    pub fn get_alert_count(&self, fund_id: String) -> u32 {
        self.alerts.get(&fund_id).map(|l| l.len()).unwrap_or(0)
    }

    // ---------- TEE underwriter verdicts ----------

    /// Register a TEE signing address after its attestation was checked off chain with a fresh nonce
    /// (phase 1, see TRUST_MODEL.md). Admin only.
    #[payable]
    pub fn add_tee_signer(&mut self, address: String, model_id: String, attestation_ref: String) {
        self.assert_admin();
        require!(!model_id.is_empty() && model_id.len() <= 128 && !model_id.contains(':'), "model_id must be 1 to 128 characters without ':'");
        require!(attestation_ref.len() <= 256, "attestation_ref too long");
        let a = norm_address(&address);
        self.tee_signers.insert(a.clone(), TeeSigner { address: a, model_id, attestation_ref, registered_at_ms: env::block_timestamp_ms() });
    }

    #[payable]
    pub fn remove_tee_signer(&mut self, address: String) {
        self.assert_admin();
        self.tee_signers.remove(&norm_address(&address));
    }

    pub fn get_tee_signers(&self) -> Vec<TeeSigner> {
        self.tee_signers.values().cloned().collect()
    }

    /// Store a TEE verdict for a loan. Anyone may submit; what is trusted is the TEE signature over
    /// "<model_id>:<sha256(request)>:<sha256(response)>" (EIP-191, provider_tee). The request (which holds
    /// the private document) is only a hash; the response must be the exact verdict-only body, which the
    /// contract hashes itself and reads the verdict from. The same signed response is accepted once.
    pub fn submit_verdict(&mut self, loan_hash: String, model_id: String, request_sha256: String, response_body: String, signature: String) -> StoredVerdict {
        require!(is_loan_hash(&loan_hash), "loan_hash must be 64 lowercase hex characters");
        require!(is_hex64(&request_sha256), "request_sha256 must be 64 lowercase hex characters");
        require!(response_body.len() <= 4096, "response_body too long");
        let response_sha256 = hex::encode(env::sha256_array(response_body.as_bytes()));
        require!(!self.seen_responses.contains(&response_sha256), "this signed response was already submitted");
        let text = format!("{model_id}:{request_sha256}:{response_sha256}");
        let signer = recover_address(&eip191_digest(&text), &signature);
        require!(signer.is_some(), "bad signature");
        let signer = signer.unwrap();
        let reg = self.tee_signers.get(&signer).cloned();
        require!(reg.is_some(), "TEE signer not registered");
        require!(reg.unwrap().model_id == model_id, "model_id does not match the registered TEE signer");
        let parsed = parse_verdict(&response_body);
        require!(parsed.is_some(), "response is not a verdict");
        let (echoed, verdict, anomalies) = parsed.unwrap();
        require!(echoed == loan_hash, "verdict is for another loan_hash");
        require!(anomalies.iter().all(|a| ANOMALY_CODES.contains(&a.as_str())), "unknown anomaly code");
        require!((verdict == "pass" && anomalies.is_empty()) || (verdict == "flag" && !anomalies.is_empty()), "verdict and anomalies disagree");

        let stored = StoredVerdict { verdict, anomalies, signer, model_id, request_sha256, response_sha256: response_sha256.clone(), at_ms: env::block_timestamp_ms() };
        self.seen_responses.insert(response_sha256);
        if !self.verdicts.contains_key(&loan_hash) {
            let k = Key::VerdictList { loan_hash: env::sha256(loan_hash.as_bytes()) };
            self.verdicts.insert(loan_hash.clone(), Vector::new(k));
        }
        self.verdicts.get_mut(&loan_hash).unwrap().push(stored.clone());
        stored
    }

    /// The latest verdict counts for the score (owner decision 6 Nov); the history stays public.
    pub fn get_latest_verdict(&self, loan_hash: String) -> Option<StoredVerdict> {
        let list = self.verdicts.get(&loan_hash)?;
        list.get(list.len().checked_sub(1)?).cloned()
    }

    pub fn get_verdict_count(&self, loan_hash: String) -> u32 {
        self.verdicts.get(&loan_hash).map(|l| l.len()).unwrap_or(0)
    }

    pub fn get_verdicts_page(&self, loan_hash: String, from_index: u32, limit: u32) -> Vec<StoredVerdict> {
        match self.verdicts.get(&loan_hash) {
            Some(list) => page(list, from_index, limit).cloned().collect(),
            None => vec![],
        }
    }

    /// Number of flag verdicts a loan has had, including ones later replaced by a pass.
    pub fn get_flag_count(&self, loan_hash: String) -> u32 {
        match self.verdicts.get(&loan_hash) {
            Some(list) => list.iter().filter(|v| v.verdict == "flag").count() as u32,
            None => 0,
        }
    }

    // ---------- NEP-171 core (pledge tokens are not transferable) ----------

    #[payable]
    pub fn nft_transfer(&mut self, receiver_id: AccountId, token_id: TokenId, approval_id: Option<u64>, memo: Option<String>) {
        let _ = (receiver_id, token_id, approval_id, memo);
        env::panic_str("pledge tokens are not transferable; the servicer releases them on repayment");
    }

    #[payable]
    pub fn nft_transfer_call(&mut self, receiver_id: AccountId, token_id: TokenId, approval_id: Option<u64>, memo: Option<String>, msg: String) -> PromiseOrValue<bool> {
        let _ = (receiver_id, token_id, approval_id, memo, msg);
        env::panic_str("pledge tokens are not transferable; the servicer releases them on repayment");
    }

    pub fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        let owner_id = self.tokens.owner_by_id.get(&token_id)?;
        let metadata = self.tokens.token_metadata_by_id.as_ref().and_then(|m| m.get(&token_id));
        Some(Token { token_id, owner_id, metadata, approved_account_ids: None })
    }

}

/// NEP-181 enumeration, so wallets and explorers can list pledge tokens (owner decision 6 Nov).
#[near]
impl NonFungibleTokenEnumeration for Registry {
    fn nft_total_supply(&self) -> U128 {
        self.tokens.nft_total_supply()
    }
    fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.tokens.nft_tokens(from_index, limit)
    }
    fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        self.tokens.nft_supply_for_owner(account_id)
    }
    fn nft_tokens_for_owner(&self, account_id: AccountId, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.tokens.nft_tokens_for_owner(account_id, from_index, limit)
    }
}

#[near]
impl NonFungibleTokenMetadataProvider for Registry {
    fn nft_metadata(&self) -> NFTContractMetadata {
        self.metadata.get().unwrap()
    }
}
