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
//! - Loan pledges: a registered fund pledges a loan by its hash. The servicer's registered secp256k1 key must
//!   sign a canonical message naming this contract, this network, the loan hash, the fund account, the asset
//!   type, a nonce and an expiry. The first pledge locks the loan and mints a NEP-171 token to the fund. A
//!   later pledge by another fund is refused with "already pledged elsewhere". That refusal, a valid signed pledge
//!   from the fund it names, stores one blocked attempt and one alert under the refused fund's id; the holder's
//!   records are not changed. A call whose caller is not the fund named in the signature stores nothing.
//!   When a pledge-ticket signer is registered, the same message also needs a ticket signature. The servicer
//!   releases the loan on repayment, which burns the token.
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
    FlagCounts,
    PledgeNonces,
    PledgeSigners,
    /// NEW-05: raw storage prefix for the pledge generation boundary of each locked loan. Appended last so every
    /// existing prefix and the Registry root layout stay the same.
    PledgeGenerations,
}

/// NEW-05: storage key of a loan's pledge generation boundary: the Key::PledgeGenerations prefix byte followed by
/// the loan hash. The value is the loan's verdict history length (u32, little endian) when its current pledge was
/// made. Only a verdict appended after that point belongs to the current pledge.
pub fn pledge_generation_key(loan_hash: &str) -> Vec<u8> {
    let mut k = near_sdk::borsh::to_vec(&Key::PledgeGenerations).expect("storage key");
    k.extend_from_slice(loan_hash.as_bytes());
    k
}

fn read_pledge_generation(loan_hash: &str) -> Option<u32> {
    let raw = env::storage_read(&pledge_generation_key(loan_hash))?;
    let b: [u8; 4] = raw.as_slice().try_into().ok()?;
    Some(u32::from_le_bytes(b))
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

/// Result of a pledge. A refusal is a normal return, not a panic. "already pledged elsewhere" stores one blocked
/// attempt and one alert under the refused fund's id (attempt_id names it); the holder's records are not changed.
/// "caller is not the fund named in the servicer signature" stores nothing (attempt_id "none").
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
    /// sha256 (hex) of the published attestation report the registrar checked (tee/fixtures/attestation-report.json).
    pub attestation_sha256: String,
    pub registered_at_ms: u64,
}

/// A secp256k1 address allowed to sign pledge tickets. The registrar stores the sha256 of that signer's
/// OutLayer attestation evidence. The contract checks the ticket signature. It does not check the quote.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PledgeSigner {
    pub address: String,
    pub attestation_ref: String,
    /// sha256 (lowercase hex) of the attestation evidence file. Re-check it with `npm run verify:pledge-signer`.
    pub attestation_sha256: String,
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
    /// sha256 of the attestation report of the TEE signer that signed this verdict.
    pub attestation_sha256: String,
    /// Expiry inside the signed binding (ms); the verdict was submitted before it.
    pub expires_at_ms: u64,
    /// "servicer" for every stored verdict (only the servicer may submit, owner decision 6 Nov).
    pub submitted_by: AccountId,
    pub at_ms: u64,
}

/// Every TEE verdict reply carries "truenav-verdict-v1|<contract id>|<network>|<expires_at_ms>" (owner decision
/// 6 Nov): a verdict signed for another deployment, another network or another version is rejected, and so is an
/// expired one or one that claims more than VERDICT_TTL_MS of validity.
pub const VERDICT_DOMAIN: &str = "truenav-verdict-v1";
pub const VERDICT_TTL_MS: u64 = 30 * 24 * 3600 * 1000;

/// Servicer pledge signatures and TEE pledge tickets use this domain. A model verdict uses VERDICT_DOMAIN,
/// so a model signature does not authorize a pledge.
pub const PLEDGE_DOMAIN: &str = "truenav-pledge-v1";
/// A pledge signature is valid only until this far ahead of the current block time.
pub const PLEDGE_TTL_MS: u64 = 24 * 3600 * 1000;

/// Canonical pledge message. The contract builds this itself from the call arguments and its own account id
/// and network. Callers do not supply the bytes that are signed.
pub fn pledge_message(
    contract: &str,
    network: &str,
    loan_hash: &str,
    fund_account: &str,
    asset_type: &str,
    nonce: &str,
    expiry_ms: u64,
) -> String {
    format!("{PLEDGE_DOMAIN}|{contract}|{network}|{loan_hash}|{fund_account}|{asset_type}|{nonce}|{expiry_ms}")
}

/// Network name from the account suffix: .testnet is testnet, .near is mainnet, anything else is that suffix
/// (a local sandbox account such as registry.sandbox gives "sandbox").
pub fn network_of(account: &str) -> String {
    match account.rsplit('.').next().unwrap_or("") {
        "testnet" => "testnet".to_string(),
        "near" => "mainnet".to_string(),
        other => other.to_string(),
    }
}

pub const ANOMALY_CODES: [&str; 6] = ["amount_mismatch", "asset_mismatch", "id_mismatch", "injection_attempt", "duplicate_document", "unreadable"];
/// The only keys a verdict reply may carry (owner decision 7 Nov). The whole response body is public transaction
/// data, so a reply with anything else is rejected, never rewritten. Mirrors tee/reply.mjs.
pub const REPLY_KEYS: [&str; 11] = [
    "loan_hash", "binding", "id_mismatch", "asset_mismatch", "amount_mismatch", "duplicate_document",
    "duplicate_evidence_line", "injection_attempt", "unreadable", "verdict", "anomalies",
];
pub const CHECK_KEYS: [&str; 6] = ["id_mismatch", "asset_mismatch", "amount_mismatch", "duplicate_document", "injection_attempt", "unreadable"];
pub const MAX_EVIDENCE_LINE: u64 = 10_000;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Registry {
    /// Roles (owner decision 6 Nov): admin assigns roles and registers funds; registrar manages signers;
    /// pauser pauses; servicer releases loans and submits TEE verdicts.
    admin: AccountId,
    servicer: AccountId,
    registrar: AccountId,
    pauser: AccountId,
    paused: bool,
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
    flag_counts: LookupMap<String, u32>,
    /// secp256k1 address of the servicer pledge key. Signatures are checked with recover_address.
    servicer_pledge_key: Option<String>,
    /// Full canonical pledge messages already accepted. A second use of the same nonce and tuple is rejected.
    pledge_nonces: LookupSet<String>,
    /// Ticket signers. Empty means a servicer signature alone is enough until ticket_required is set.
    pledge_signers: IterableMap<String, PledgeSigner>,
    /// Set when the first ticket signer is registered. Removing signers does not clear it.
    ticket_required: bool,
}

/// Role assignment, readable by anyone.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Roles {
    pub admin: AccountId,
    pub registrar: AccountId,
    pub pauser: AccountId,
    pub servicer: AccountId,
    pub paused: bool,
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

/// True when any JSON object in `text` repeats a key (escapes decoded). serde_json keeps the LAST value of a
/// duplicated key while the earlier value stays in the public transaction data, so a duplicate could carry document
/// text past every other check. Mirrors duplicateKey in tee/reply.mjs. The text must already be valid JSON.
pub fn has_duplicate_key(text: &str) -> bool {
    let b = text.as_bytes();
    let mut stack: Vec<Option<Vec<String>>> = Vec::new();
    let mut expect_key = false;
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'{' => { stack.push(Some(Vec::new())); expect_key = true; }
            b'[' => { stack.push(None); expect_key = false; }
            b'}' | b']' => { stack.pop(); expect_key = false; }
            b',' => { expect_key = matches!(stack.last(), Some(Some(_))); }
            b'"' => {
                let mut j = i + 1;
                while j < b.len() && b[j] != b'"' { j += if b[j] == b'\\' { 2 } else { 1 }; }
                if expect_key {
                    let key: String = match near_sdk::serde_json::from_str(&text[i..(j + 1).min(b.len())]) { Ok(k) => k, Err(_) => return true };
                    if let Some(Some(keys)) = stack.last_mut() {
                        if keys.contains(&key) { return true; }
                        keys.push(key);
                    }
                    expect_key = false;
                }
                i = j;
            }
            _ => {}
        }
        i += 1;
    }
    false
}

/// The model's reply text inside the message content: one optional code fence stripped, as tee/reply.mjs does.
fn strip_fence(content: &str) -> &str {
    let c = content.trim();
    let c = c.strip_prefix("```json").or_else(|| c.strip_prefix("```")).unwrap_or(c).trim_start();
    c.strip_suffix("```").unwrap_or(c).trim_end()
}

/// None when the reply holds only the allowed keys with the allowed value types; otherwise the first problem.
/// Rejects: extra keys in the reply, free text in check fields, a non-number evidence line, unknown anomaly codes,
/// a non-empty provider field beside role and content, and anything but exactly one choice.
pub fn reply_problem(response_body: &str) -> Option<&'static str> {
    use near_sdk::serde_json::Value;
    let body: Value = match near_sdk::serde_json::from_str(response_body) { Ok(v) => v, Err(_) => return Some("response is not JSON") };
    if has_duplicate_key(response_body) {
        return Some("response has a duplicate key");
    }
    let choices = match body.get("choices").and_then(|c| c.as_array()) { Some(c) if c.len() == 1 => c, _ => return Some("response must have exactly one choice") };
    let msg = match choices[0].get("message").and_then(|m| m.as_object()) { Some(m) => m, None => return Some("response has no message") };
    if msg.iter().any(|(k, v)| k != "role" && k != "content" && !v.is_null()) {
        return Some("message has a non-empty field beside role and content");
    }
    let content = match msg.get("content").and_then(|c| c.as_str()) { Some(c) => strip_fence(c), None => return Some("reply is not one JSON object") };
    let r = match near_sdk::serde_json::from_str::<Value>(content) { Ok(Value::Object(o)) => o, _ => return Some("reply is not one JSON object") };
    if has_duplicate_key(content) {
        return Some("reply has a duplicate key");
    }
    if r.keys().any(|k| !REPLY_KEYS.contains(&k.as_str())) {
        return Some("reply has a key outside the allowed list");
    }
    match r.get("loan_hash").and_then(|v| v.as_str()) {
        Some(h) if h.len() <= 71 && h.bytes().filter(|c| *c != b' ').count() == 64 && h.bytes().all(|c| c.is_ascii_hexdigit() || c == b' ') => {}
        _ => return Some("loan_hash is not a 64-hex hash"),
    }
    match r.get("binding").and_then(|v| v.as_str()) {
        Some(b) if b.len() <= 160 && b.chars().all(|c| c.is_ascii_alphanumeric() || "._|- ".contains(c)) => {}
        _ => return Some("binding is not a binding"),
    }
    for k in CHECK_KEYS {
        if let Some(v) = r.get(k) {
            if v.as_str() != Some("ok") && v.as_str() != Some("fail") {
                return Some("a check must be ok or fail");
            }
        }
    }
    if let Some(v) = r.get("duplicate_evidence_line") {
        let ok = v.as_str() == Some("ok") || v.as_u64().map(|n| (1..=MAX_EVIDENCE_LINE).contains(&n)).unwrap_or(false);
        if !ok {
            return Some("duplicate_evidence_line must be a line number or ok");
        }
    }
    match r.get("verdict").and_then(|v| v.as_str()) {
        Some("pass") | Some("flag") => {}
        _ => return Some("verdict must be pass or flag"),
    }
    match r.get("anomalies").and_then(|v| v.as_array()) {
        Some(a) if a.iter().all(|x| x.as_str().map(|s| ANOMALY_CODES.contains(&s)).unwrap_or(false)) => {}
        _ => return Some("anomalies must be known codes"),
    }
    None
}

/// Read {loan_hash, verdict, anomalies} from the model's reply inside the exact response body.
/// The model writes the loan hash in 8-character groups; spaces are removed before comparing.
pub fn parse_verdict(response_body: &str) -> Option<(String, String, Vec<String>, String)> {
    let body: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(response_body).ok()?;
    let content = strip_fence(body.get("choices")?.get(0)?.get("message")?.get("content")?.as_str()?);
    let v: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(content).ok()?;
    let loan_hash: String = v.get("loan_hash")?.as_str()?.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_ascii_lowercase();
    let verdict = v.get("verdict")?.as_str()?.to_string();
    let anomalies = v.get("anomalies")?.as_array()?.iter().map(|a| a.as_str().map(|x| x.to_string())).collect::<Option<Vec<_>>>()?;
    let binding: String = v.get("binding")?.as_str()?.chars().filter(|c| !c.is_whitespace()).collect();
    Some((loan_hash, verdict, anomalies, binding))
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
            registrar: admin.clone(),
            pauser: admin.clone(),
            paused: false,
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
            flag_counts: LookupMap::new(Key::FlagCounts),
            servicer_pledge_key: None,
            pledge_nonces: LookupSet::new(Key::PledgeNonces),
            pledge_signers: IterableMap::new(Key::PledgeSigners),
            ticket_required: false,
        }
    }

    /// Admin only, and the call must carry exactly 1 yoctoNEAR so only a full-access key can make it.
    fn assert_admin(&self) {
        assert_one_yocto();
        require!(env::predecessor_account_id() == self.admin, "admin only");
    }

    fn assert_registrar(&self) {
        assert_one_yocto();
        require!(env::predecessor_account_id() == self.registrar, "registrar only");
    }

    fn assert_servicer(&self) {
        assert_one_yocto();
        require!(env::predecessor_account_id() == self.servicer, "servicer only");
    }

    fn assert_not_paused(&self) {
        require!(!self.paused, "paused");
    }

    // ---------- roles and pause ----------

    /// Admin moves a role to another account: "admin", "registrar", "pauser" or "servicer".
    #[payable]
    pub fn set_role(&mut self, role: String, account_id: AccountId) {
        self.assert_admin();
        match role.as_str() {
            "admin" => self.admin = account_id,
            "registrar" => self.registrar = account_id,
            "pauser" => self.pauser = account_id,
            "servicer" => self.servicer = account_id,
            _ => env::panic_str("role must be admin, registrar, pauser or servicer"),
        }
    }

    pub fn get_roles(&self) -> Roles {
        Roles { admin: self.admin.clone(), registrar: self.registrar.clone(), pauser: self.pauser.clone(), servicer: self.servicer.clone(), paused: self.paused }
    }

    /// Emergency stop: pledges, releases, certificate and verdict submissions are refused; views and role
    /// changes keep working.
    #[payable]
    pub fn pause(&mut self) {
        assert_one_yocto();
        require!(env::predecessor_account_id() == self.pauser, "pauser only");
        self.paused = true;
    }

    #[payable]
    pub fn unpause(&mut self) {
        assert_one_yocto();
        require!(env::predecessor_account_id() == self.pauser, "pauser only");
        self.paused = false;
    }

    // ---------- signer registry ----------

    #[payable]
    pub fn add_signer(&mut self, address: String) {
        self.assert_registrar();
        let a = norm_address(&address);
        self.signers.insert(a);
    }

    #[payable]
    pub fn remove_signer(&mut self, address: String) {
        self.assert_registrar();
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
        self.assert_not_paused();
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

    // ---------- loan pledges and NEP-171 tokens ----------

    /// Admin registers the secp256k1 address whose EIP-191 signatures authorize pledges.
    #[payable]
    pub fn set_servicer_pledge_key(&mut self, address: String) {
        self.assert_admin();
        self.servicer_pledge_key = Some(norm_address(&address));
    }

    pub fn get_servicer_pledge_key(&self) -> Option<String> {
        self.servicer_pledge_key.clone()
    }

    /// Registrar registers a ticket signer and the sha256 of its OutLayer attestation evidence.
    /// This does not put the address on the TEE verdict allowlist, and a TEE verdict signer is not a ticket signer.
    #[payable]
    pub fn add_pledge_signer(&mut self, address: String, attestation_ref: String, attestation_sha256: String) {
        self.assert_registrar();
        require!(is_hex64(&attestation_sha256), "attestation_sha256 must be 64 lowercase hex characters");
        require!(!attestation_ref.is_empty() && attestation_ref.len() <= 256, "attestation_ref must be 1 to 256 characters");
        let a = norm_address(&address);
        self.ticket_required = true;
        self.pledge_signers.insert(
            a.clone(),
            PledgeSigner { address: a, attestation_ref, attestation_sha256, registered_at_ms: env::block_timestamp_ms() },
        );
    }

    #[payable]
    pub fn remove_pledge_signer(&mut self, address: String) {
        self.assert_registrar();
        self.pledge_signers.remove(&norm_address(&address));
    }

    pub fn get_pledge_signers(&self) -> Vec<PledgeSigner> {
        self.pledge_signers.values().cloned().collect()
    }

    pub fn pledge_message_used(&self, message: String) -> bool {
        self.pledge_nonces.contains(&message)
    }

    /// Pledge a loan by its hash (64 lowercase hex). The predecessor must be the registered fund account
    /// named in a fresh servicer signature. When any ticket signer is registered, the same message also
    /// needs a ticket from one of those signers.
    // Public NEAR method: the argument list is the call ABI, so it is kept as is.
    #[allow(clippy::too_many_arguments)]
    #[payable]
    pub fn pledge_loan(
        &mut self,
        loan_hash: String,
        asset_type: String,
        fund_account: AccountId,
        nonce: String,
        expiry_ms: u64,
        servicer_signature: String,
        ticket_signature: Option<String>,
    ) -> PledgeOutcome {
        assert_one_yocto();
        self.assert_not_paused();
        require!(is_loan_hash(&loan_hash), "loan_hash must be 64 lowercase hex characters");
        require!(asset_type == "real_estate" || asset_type == "invoices", "asset_type must be real_estate or invoices");
        require!(nonce.len() >= 32 && nonce.len() <= 64 && nonce.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()), "nonce must be 32 to 64 lowercase hex characters");
        require!(!fund_account.as_str().contains('|'), "fund_account must not contain '|'");
        let contract = env::current_account_id();
        let network = network_of(contract.as_str());
        let message = pledge_message(contract.as_str(), &network, &loan_hash, fund_account.as_str(), &asset_type, &nonce, expiry_ms);
        let digest = eip191_digest(&message);
        let expected = self.servicer_pledge_key.as_deref().unwrap_or_else(|| env::panic_str("servicer pledge key is not set"));
        let signer = recover_address(&digest, &servicer_signature).unwrap_or_else(|| env::panic_str("bad servicer signature"));
        require!(signer == expected, "servicer signature not from the registered pledge key");
        let now = env::block_timestamp_ms();
        require!(expiry_ms > now, "pledge expired");
        require!(expiry_ms <= now.saturating_add(PLEDGE_TTL_MS), "pledge expiry too far");
        if self.ticket_required {
            let ticket = ticket_signature.unwrap_or_else(|| env::panic_str("ticket signature required"));
            let ticket_signer = recover_address(&digest, &ticket).unwrap_or_else(|| env::panic_str("bad ticket signature"));
            require!(self.pledge_signers.contains_key(&ticket_signer), "ticket signer not registered");
        }
        let caller = env::predecessor_account_id();
        if caller != fund_account {
            // The signature names another fund. Do not store the nonce and do not touch that fund's counters.
            return PledgeOutcome::Refused { message: "caller is not the fund named in the servicer signature".to_string(), attempt_id: "none".to_string() };
        }
        let fund_id = self.fund_by_account.get(&caller).cloned();
        require!(fund_id.is_some(), "caller is not a registered fund account");
        let fund_id = fund_id.unwrap();
        require!(!self.pledge_nonces.contains(&message), "pledge nonce already used");
        self.pledge_nonces.insert(message);

        if let Some(lock) = self.locks.get(&loan_hash).cloned() {
            if lock.fund_id == fund_id {
                return PledgeOutcome::AlreadyYours { token_id: loan_hash };
            }
            // A valid signature (and a ticket, when required) reached this point. Count it on the signing fund only.
            self.attempt_seq += 1;
            let attempt_id = format!("attempt-{}", self.attempt_seq);
            let fh = fund_hash(&fund_id);
            if !self.attempts.contains_key(&fund_id) {
                self.attempts.insert(fund_id.clone(), Vector::new(Key::AttemptList { fund_hash: fh.clone() }));
            }
            self.attempts.get_mut(&fund_id).unwrap().push(Attempt { attempt_id: attempt_id.clone(), at_ms: now });
            if !self.alerts.contains_key(&fund_id) {
                self.alerts.insert(fund_id.clone(), Vector::new(Key::AlertList { fund_hash: fh }));
            }
            self.alerts.get_mut(&fund_id).unwrap().push(now);
            return PledgeOutcome::Refused { message: "already pledged elsewhere".to_string(), attempt_id };
        }

        self.locks.insert(loan_hash.clone(), Lock { fund_id, locked_at_ms: now });
        // NEW-05: a new pledge generation starts after every verdict stored so far, so no earlier verdict can count
        // for it, even one stored in the same millisecond. AlreadyYours and refusals returned above do not reach here.
        let boundary = self.verdicts.get(&loan_hash).map(|l| l.len()).unwrap_or(0);
        env::storage_write(&pledge_generation_key(&loan_hash), &boundary.to_le_bytes());
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
        self.assert_servicer();
        self.assert_not_paused();
        require!(self.locks.remove(&loan_hash).is_some(), "loan not pledged");
        env::storage_remove(&pledge_generation_key(&loan_hash));
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

    /// One page of a fund's blocked attempts, oldest first (limit capped at PAGE_MAX).
    pub fn get_attempts_page(&self, fund_id: String, from_index: u32, limit: u32) -> AttemptSummary {
        match self.attempts.get(&fund_id) {
            Some(list) => AttemptSummary { count: list.len(), attempts: page(list, from_index, limit).cloned().collect() },
            None => AttemptSummary { count: 0, attempts: vec![] },
        }
    }

    /// Alert times stored under this fund_id: one per "already pledged elsewhere" refusal of this fund's signed
    /// pledge, appended at the block time of the refusal. Oldest first (limit capped at PAGE_MAX).
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
    /// (phase 1, see TRUST_MODEL.md). Registrar only. attestation_sha256 is the sha256 (hex) of the published
    /// attestation report, so anyone can re-check it (npm run verify:attestation).
    #[payable]
    pub fn add_tee_signer(&mut self, address: String, model_id: String, attestation_ref: String, attestation_sha256: String) {
        self.assert_registrar();
        require!(is_hex64(&attestation_sha256), "attestation_sha256 must be 64 lowercase hex characters");
        require!(!model_id.is_empty() && model_id.len() <= 128 && !model_id.contains(':'), "model_id must be 1 to 128 characters without ':'");
        require!(attestation_ref.len() <= 256, "attestation_ref too long");
        let a = norm_address(&address);
        self.tee_signers.insert(a.clone(), TeeSigner { address: a, model_id, attestation_ref, attestation_sha256, registered_at_ms: env::block_timestamp_ms() });
    }

    #[payable]
    pub fn remove_tee_signer(&mut self, address: String) {
        self.assert_registrar();
        self.tee_signers.remove(&norm_address(&address));
    }

    pub fn get_tee_signers(&self) -> Vec<TeeSigner> {
        self.tee_signers.values().cloned().collect()
    }

    /// Store a TEE verdict for a pledged loan. Only the servicer may submit (owner decision 6 Nov). What is trusted
    /// is the TEE signature over "<model_id>:<sha256(request)>:<sha256(response)>" (EIP-191, provider_tee). The
    /// request (which holds the private document) is only a hash; the response must be the exact verdict-only
    /// body, which the contract hashes itself and reads the verdict and binding from. The binding must name this
    /// contract, this network, the current version and an unexpired time. A flag on the current pledge is cleared
    /// only by a later servicer pass from a different request (a speed bump, not a lock: the servicer controls the
    /// request). Each signed response is accepted once.
    #[payable]
    pub fn submit_verdict(&mut self, loan_hash: String, model_id: String, request_sha256: String, response_body: String, signature: String) -> StoredVerdict {
        self.assert_servicer();
        self.assert_not_paused();
        require!(is_loan_hash(&loan_hash), "loan_hash must be 64 lowercase hex characters");
        // The response body is public transaction data: a reply with anything beyond the allowed keys and value
        // types is refused first, whatever its signature (owner decision 7 Nov). A rejection, never a rewrite.
        require!(response_body.len() <= 4096, "response_body too long");
        if let Some(problem) = reply_problem(&response_body) {
            env::panic_str(problem);
        }
        let lock = self.locks.get(&loan_hash).cloned();
        require!(lock.is_some(), "loan not pledged");
        let lock = lock.unwrap();
        require!(is_hex64(&request_sha256), "request_sha256 must be 64 lowercase hex characters");
        let response_sha256 = hex::encode(env::sha256_array(response_body.as_bytes()));
        require!(!self.seen_responses.contains(&response_sha256), "this signed response was already submitted");
        let text = format!("{model_id}:{request_sha256}:{response_sha256}");
        let signer = recover_address(&eip191_digest(&text), &signature);
        require!(signer.is_some(), "bad signature");
        let signer = signer.unwrap();
        let reg = self.tee_signers.get(&signer).cloned();
        require!(reg.is_some(), "TEE signer not registered");
        let reg = reg.unwrap();
        require!(reg.model_id == model_id, "model_id does not match the registered TEE signer");
        let parsed = parse_verdict(&response_body);
        require!(parsed.is_some(), "response is not a verdict");
        let (echoed, verdict, anomalies, binding) = parsed.unwrap();
        require!(echoed == loan_hash, "verdict is for another loan_hash");
        let now = env::block_timestamp_ms();
        let parts: Vec<&str> = binding.split('|').collect();
        require!(parts.len() == 4 && parts[0] == VERDICT_DOMAIN, "verdict binding has an unknown version");
        let me = env::current_account_id();
        require!(parts[1] == me.as_str(), "verdict is bound to another contract");
        require!(parts[2] == network_of(me.as_str()), "verdict is bound to another network");
        let expires_at_ms: u64 = parts[3].parse().unwrap_or(0);
        require!(expires_at_ms >= now, "verdict expired");
        require!(expires_at_ms <= now + VERDICT_TTL_MS + 3_600_000, "verdict validity longer than 30 days");
        require!(anomalies.iter().all(|a| ANOMALY_CODES.contains(&a.as_str())), "unknown anomaly code");
        require!((verdict == "pass" && anomalies.is_empty()) || (verdict == "flag" && !anomalies.is_empty()), "verdict and anomalies disagree");
        // A flag on the current pledge clears only with a pass from a different request.
        if verdict == "pass" {
            if let Some(prev) = self.latest_for_pledge(&loan_hash, &lock) {
                require!(!(prev.verdict == "flag" && prev.request_sha256 == request_sha256), "a flag clears only with a pass from a new request");
            }
        }

        let stored = StoredVerdict {
            verdict,
            anomalies,
            signer,
            model_id,
            request_sha256,
            response_sha256: response_sha256.clone(),
            attestation_sha256: reg.attestation_sha256,
            expires_at_ms,
            submitted_by: env::predecessor_account_id(),
            at_ms: now,
        };
        self.seen_responses.insert(response_sha256);
        if stored.verdict == "flag" {
            let n = self.flag_counts.get(&loan_hash).copied().unwrap_or(0);
            self.flag_counts.insert(loan_hash.clone(), n + 1);
        }
        if !self.verdicts.contains_key(&loan_hash) {
            let k = Key::VerdictList { loan_hash: env::sha256(loan_hash.as_bytes()) };
            self.verdicts.insert(loan_hash.clone(), Vector::new(k));
        }
        self.verdicts.get_mut(&loan_hash).unwrap().push(stored.clone());
        stored
    }

    /// The latest verdict of the current pledge generation. A pledge made by this code stores a boundary (the verdict
    /// count when it was made), and only a verdict appended after it counts. A lock made before this upgrade has no
    /// boundary and keeps the old time rule (verdict at_ms >= locked_at_ms), which still lets a verdict stored in
    /// the same millisecond as that pledge count for it (NEW-05, legacy locks only).
    fn latest_for_pledge(&self, loan_hash: &String, lock: &Lock) -> Option<StoredVerdict> {
        let list = self.verdicts.get(loan_hash)?;
        let last = list.get(list.len().checked_sub(1)?)?;
        match read_pledge_generation(loan_hash) {
            Some(boundary) => if list.len() > boundary { Some(last.clone()) } else { None },
            None => if last.at_ms >= lock.locked_at_ms { Some(last.clone()) } else { None },
        }
    }

    /// The latest verdict for the current pledge counts for the score (owner decisions 6 Nov): None when the loan
    /// is not pledged or has no verdict since its pledge (since its pledge generation boundary, NEW-05). The full history stays public (get_verdicts_page).
    pub fn get_latest_verdict(&self, loan_hash: String) -> Option<StoredVerdict> {
        let lock = self.locks.get(&loan_hash).cloned()?;
        self.latest_for_pledge(&loan_hash, &lock)
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

    /// Number of flag verdicts a loan has had, including ones later replaced by a pass (stored counter).
    pub fn get_flag_count(&self, loan_hash: String) -> u32 {
        self.flag_counts.get(&loan_hash).copied().unwrap_or(0)
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
