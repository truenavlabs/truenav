//! TrueNav receipt contract (NEAR testnet only). Build step 4, spec/v2/SPEC.md sections 8.1, 8.2 and 13.
//!
//! - `request_run(token_id)`: a runner asks OutLayer (`request_execution`) to run the pinned engine build for one
//!   registered token. The public input is only `{"token_id", "run_nonce"}`; the TEE fetches the private records
//!   itself with sealed credentials (`secrets_ref`). The nonce comes from this contract, so a receipt cannot be
//!   replayed into another request.
//! - `on_run_result`: private callback. The receipt must answer exactly the pending request (token, nonce, method,
//!   kind) and pass the whitelist in `validate.rs` (aggregates, caps and holds with reasons, public metrics, passport
//!   with whole-document hashes, nothing else). Then it is stored with a per-token sequence number, the sha256 of the
//!   bytes as received, and the build the request pinned. A module error or a rejected receipt stores only a short
//!   failure code for that token.
//! - Views for the API: `get_latest`, `get_receipt`, `get_history`, `get_token`, `list_tokens`, `get_config`.
//! - Roles: admin (config, tokens, runners, pinned build), pauser (pause and unpause), runners (request runs).
//!
//! This contract never holds or moves fund money. It holds only the deposits that pay for a run (forwarded to
//! OutLayer, whose unused part OutLayer refunds to the requester) and for receipt storage (the unused part is
//! refunded to the requester in the callback). Everything stored here is public chain state.
pub mod validate;

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::{IterableMap, IterableSet, LookupMap};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError};
use validate::{check, is_stage, is_token_id, Expect, MAX_RECEIPT_BYTES};

pub const EVENT_STANDARD: &str = "truenav-receipts";
pub const EVENT_VERSION: &str = "1.0.0";
const MAX_HISTORY_PAGE: u64 = 10;

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Tokens,
    Runners,
    Pending,
    Receipts,
    Failures,
}

/// How runs are requested. The pinned build is `project_id` at the fixed `version_key` (never "latest").
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub outlayer: AccountId,
    pub project_id: String,
    pub version_key: String,
    pub method: String,
    pub secrets_profile: String,
    pub secrets_owner: AccountId,
    pub max_instructions: u64,
    pub max_memory_mb: u32,
    pub max_execution_seconds: u32,
    /// forwarded to OutLayer with each request (its unused part is refunded by OutLayer to the requester)
    pub outlayer_deposit: U128,
    /// held for the receipt's storage; the unused part goes back to the requester in the callback
    pub storage_deposit: U128,
    pub outlayer_tgas: u64,
    pub callback_tgas: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct TokenInfo {
    pub token_id: String,
    pub kind: String,
    pub receipts: u64,
    pub registered_ns: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Pending {
    pub request_id: u64,
    pub token_id: String,
    pub run_nonce: String,
    pub requester: AccountId,
    pub version_key: String,
    pub storage_deposit: U128,
    pub requested_ns: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct StoredReceipt {
    pub token_id: String,
    pub seq: u64,
    pub request_id: u64,
    pub method: String,
    /// the build this contract pinned in the request (what counts; the receipt's own fields are informational)
    pub version_key: String,
    pub score: u64,
    pub band: String,
    pub period: String,
    pub as_of: String,
    pub caps: Vec<String>,
    pub holds: Vec<String>,
    /// sha256 of the receipt bytes exactly as OutLayer delivered them
    pub receipt_sha256: String,
    /// the receipt JSON as delivered
    pub receipt: String,
    pub requested_ns: u64,
    pub stored_ns: u64,
    pub block_height: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Failure {
    pub request_id: u64,
    pub code: String,
    pub at_ns: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Receipts {
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

fn emit(event: &str, data: Value) {
    env::log_str(&format!("EVENT_JSON:{}", json!({ "standard": EVENT_STANDARD, "version": EVENT_VERSION, "event": event, "data": [data] })));
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn check_config(c: &Config) {
    require!(!c.project_id.is_empty() && c.project_id.len() <= 128, "bad project_id");
    require!(c.version_key.len() == 64 && c.version_key.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)), "version_key must be a 64-hex wasm hash, never latest");
    require!(c.method.starts_with("cashflow-v2."), "unknown method");
    require!(!c.secrets_profile.is_empty() && c.secrets_profile.len() <= 64, "bad secrets_profile");
    require!(c.outlayer_tgas + c.callback_tgas <= 290, "gas above 290 Tgas");
    require!(c.callback_tgas >= 20 && c.outlayer_tgas >= 50, "gas too low");
    // a receipt is at most MAX_RECEIPT_BYTES; the stored record roughly doubles it with its index fields
    let worst = (2 * MAX_RECEIPT_BYTES as u128 + 1_000) * env::storage_byte_cost().as_yoctonear();
    require!(c.storage_deposit.0 >= worst, "storage_deposit too low for the largest receipt");
}

#[near]
impl Receipts {
    #[init]
    pub fn new(admin: AccountId, pauser: AccountId, config: Config) -> Self {
        check_config(&config);
        Self {
            admin,
            proposed_admin: None,
            pauser,
            paused: false,
            config,
            next_request: 1,
            tokens: IterableMap::new(Key::Tokens),
            runners: IterableSet::new(Key::Runners),
            pending: LookupMap::new(Key::Pending),
            receipts: LookupMap::new(Key::Receipts),
            failures: LookupMap::new(Key::Failures),
        }
    }

    // ---- roles -------------------------------------------------------------------------------------------------
    fn only_admin(&self) {
        require!(env::predecessor_account_id() == self.admin, "admin only");
    }
    pub fn propose_admin(&mut self, account: AccountId) {
        self.only_admin();
        self.proposed_admin = Some(account);
    }
    pub fn accept_admin(&mut self) {
        let me = env::predecessor_account_id();
        require!(self.proposed_admin.as_ref() == Some(&me), "not the proposed admin");
        emit("admin_changed", json!({ "old": self.admin, "new": me }));
        self.admin = me;
        self.proposed_admin = None;
    }
    pub fn set_pauser(&mut self, account: AccountId) {
        self.only_admin();
        self.pauser = account;
    }
    pub fn set_runner(&mut self, account: AccountId, allowed: bool) {
        self.only_admin();
        if allowed {
            self.runners.insert(account.clone());
        } else {
            self.runners.remove(&account);
        }
        emit("runner_set", json!({ "account": account, "allowed": allowed }));
    }
    pub fn pause(&mut self) {
        let me = env::predecessor_account_id();
        require!(me == self.pauser || me == self.admin, "pauser or admin only");
        self.paused = true;
        emit("paused", json!({ "by": me }));
    }
    pub fn unpause(&mut self) {
        let me = env::predecessor_account_id();
        require!(me == self.pauser || me == self.admin, "pauser or admin only");
        self.paused = false;
        emit("unpaused", json!({ "by": me }));
    }
    /// Change how runs are requested, including the pinned build. Pending requests keep the build they pinned.
    pub fn set_config(&mut self, config: Config) {
        self.only_admin();
        check_config(&config);
        emit("config_changed", json!({ "old_version_key": self.config.version_key, "new_version_key": config.version_key, "method": config.method }));
        self.config = config;
    }
    pub fn register_token(&mut self, token_id: String, kind: String) {
        self.only_admin();
        require!(is_token_id(&token_id), "token_id must match [A-Z0-9-]{1,64}");
        require!(kind == "credit" || kind == "rental", "kind must be credit or rental");
        require!(self.tokens.get(&token_id).is_none(), "token already registered");
        self.tokens.insert(token_id.clone(), TokenInfo { token_id: token_id.clone(), kind: kind.clone(), receipts: 0, registered_ns: env::block_timestamp() });
        emit("token_registered", json!({ "token_id": token_id, "kind": kind }));
    }
    /// Drop a pending request whose callback never arrived (OutLayer's yield always resumes or times out, so this
    /// is a last resort). Its storage deposit goes back to the requester.
    pub fn clear_pending(&mut self, token_id: String) -> Promise {
        self.only_admin();
        let p = self.pending.remove(&token_id).unwrap_or_else(|| env::panic_str("no pending request"));
        emit("pending_cleared", json!({ "token_id": token_id, "request_id": p.request_id }));
        Promise::new(p.requester).transfer(NearToken::from_yoctonear(p.storage_deposit.0))
    }

    // ---- runs --------------------------------------------------------------------------------------------------
    #[payable]
    pub fn request_run(&mut self, token_id: String) -> Promise {
        require!(!self.paused, "paused");
        let requester = env::predecessor_account_id();
        require!(self.runners.contains(&requester), "runner only");
        require!(self.tokens.get(&token_id).is_some(), "unknown token");
        require!(self.pending.get(&token_id).is_none(), "a run is already pending for this token");
        let c = self.config.clone();
        let need = c.outlayer_deposit.0 + c.storage_deposit.0;
        let attached = env::attached_deposit().as_yoctonear();
        require!(attached >= need, format!("attach at least {need} yoctoNEAR"));
        require!(env::prepaid_gas().as_tgas() >= c.outlayer_tgas + c.callback_tgas + 10, "not enough gas");

        let request_id = self.next_request;
        self.next_request += 1;
        let mut seed = env::random_seed();
        seed.extend_from_slice(&request_id.to_le_bytes());
        seed.extend_from_slice(token_id.as_bytes());
        let run_nonce = hex(&env::sha256(&seed));
        self.pending.insert(
            token_id.clone(),
            Pending { request_id, token_id: token_id.clone(), run_nonce: run_nonce.clone(), requester: requester.clone(), version_key: c.version_key.clone(), storage_deposit: c.storage_deposit, requested_ns: env::block_timestamp() },
        );
        let input = json!({ "token_id": token_id, "run_nonce": run_nonce }).to_string();
        let args = json!({
            "source": { "Project": { "project_id": c.project_id, "version_key": c.version_key } },
            "resource_limits": { "max_instructions": c.max_instructions, "max_memory_mb": c.max_memory_mb, "max_execution_seconds": c.max_execution_seconds },
            "input_data": input,
            "secrets_ref": { "profile": c.secrets_profile, "account_id": c.secrets_owner },
            "response_format": "Json",
            "payer_account_id": requester,
            "params": null,
        });
        emit("run_requested", json!({ "token_id": token_id, "request_id": request_id, "run_nonce": run_nonce, "version_key": c.version_key, "method": c.method }));
        if attached > need {
            Promise::new(requester).transfer(NearToken::from_yoctonear(attached - need)).detach();
        }
        Promise::new(c.outlayer.clone())
            .function_call("request_execution", args.to_string().into_bytes(), NearToken::from_yoctonear(c.outlayer_deposit.0), Gas::from_tgas(c.outlayer_tgas))
            .then(Promise::new(env::current_account_id()).function_call(
                "on_run_result",
                json!({ "token_id": token_id, "request_id": request_id }).to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                Gas::from_tgas(c.callback_tgas),
            ))
    }

    #[private]
    pub fn on_run_result(&mut self, token_id: String, request_id: u64) -> String {
        let Some(p) = self.pending.get(&token_id).cloned() else { return "no_pending".into() };
        if p.request_id != request_id {
            return "stale_callback".into();
        }
        self.pending.remove(&token_id);
        let before = env::storage_usage();
        // read at most MAX_RECEIPT_BYTES, so an oversized result cannot run the callback out of gas
        let outcome = match env::promise_result_checked(0, MAX_RECEIPT_BYTES) {
            Ok(bytes) => self.accept(&p, &bytes),
            Err(PromiseError::TooLong(_)) => Err("receipt_too_large".to_string()),
            Err(_) => Err("outlayer_failed".to_string()),
        };
        let code = match outcome {
            Ok(seq) => format!("stored:{seq}"),
            Err(code) => {
                self.failures.insert(token_id.clone(), Failure { request_id, code: code.clone(), at_ns: env::block_timestamp() });
                emit("run_failed", json!({ "token_id": token_id, "request_id": request_id, "code": code }));
                code
            }
        };
        let after = env::storage_usage();
        let used = (after.saturating_sub(before) as u128) * env::storage_byte_cost().as_yoctonear();
        let refund = p.storage_deposit.0.saturating_sub(used);
        if refund > 0 {
            Promise::new(p.requester).transfer(NearToken::from_yoctonear(refund)).detach();
        }
        code
    }

    fn accept(&mut self, p: &Pending, bytes: &[u8]) -> Result<u64, String> {
        if bytes.len() > MAX_RECEIPT_BYTES {
            return Err("receipt_too_large".into());
        }
        let mut v: Value = serde_json::from_slice(bytes).map_err(|_| "receipt_not_json".to_string())?;
        // tolerate an output delivered as a JSON string holding the JSON
        if let Value::String(s) = &v {
            v = serde_json::from_str(s).map_err(|_| "receipt_not_json".to_string())?;
        }
        if let Some(stage) = v.get("error").and(v.get("stage")).and_then(Value::as_str) {
            return Err(if is_stage(stage) { format!("module_failed:{stage}") } else { "module_failed".into() });
        }
        let token = self.tokens.get(&p.token_id).cloned().ok_or("unknown_token")?;
        let s = check(&v, &Expect { method: &self.config.method, token_id: &p.token_id, kind: &token.kind, run_nonce: &p.run_nonce })?;
        let seq = token.receipts + 1;
        let receipt = String::from_utf8(bytes.to_vec()).map_err(|_| "receipt_not_utf8".to_string())?;
        let sha = hex(&env::sha256(bytes));
        emit("receipt_stored", json!({ "token_id": p.token_id, "seq": seq, "request_id": p.request_id, "score": s.score, "band": s.band, "caps": s.caps, "holds": s.holds, "method": self.config.method, "version_key": p.version_key, "receipt_sha256": sha }));
        self.receipts.insert(
            (p.token_id.clone(), seq),
            StoredReceipt {
                token_id: p.token_id.clone(),
                seq,
                request_id: p.request_id,
                method: self.config.method.clone(),
                version_key: p.version_key.clone(),
                score: s.score,
                band: s.band,
                period: s.period,
                as_of: s.as_of,
                caps: s.caps,
                holds: s.holds,
                receipt_sha256: sha,
                receipt,
                requested_ns: p.requested_ns,
                stored_ns: env::block_timestamp(),
                block_height: env::block_height(),
            },
        );
        let mut t = token;
        t.receipts = seq;
        self.tokens.insert(p.token_id.clone(), t);
        self.failures.remove(&p.token_id);
        Ok(seq)
    }

    // ---- views -------------------------------------------------------------------------------------------------
    pub fn get_config(&self) -> Value {
        json!({ "admin": self.admin, "pauser": self.pauser, "paused": self.paused, "config": self.config, "next_request": self.next_request })
    }
    pub fn is_runner(&self, account: AccountId) -> bool {
        self.runners.contains(&account)
    }
    pub fn get_token(&self, token_id: String) -> Option<Value> {
        let t = self.tokens.get(&token_id)?;
        Some(json!({ "token": t, "pending": self.pending.get(&token_id), "last_failure": self.failures.get(&token_id) }))
    }
    pub fn list_tokens(&self, from: Option<u64>, limit: Option<u64>) -> Vec<TokenInfo> {
        self.tokens.values().skip(from.unwrap_or(0) as usize).take(limit.unwrap_or(50).min(100) as usize).cloned().collect()
    }
    pub fn get_latest(&self, token_id: String) -> Option<StoredReceipt> {
        let n = self.tokens.get(&token_id)?.receipts;
        if n == 0 {
            return None;
        }
        self.receipts.get(&(token_id, n)).cloned()
    }
    pub fn get_receipt(&self, token_id: String, seq: u64) -> Option<StoredReceipt> {
        self.receipts.get(&(token_id, seq)).cloned()
    }
    /// Newest first, from `from_seq` (default the latest) down, at most 10 per page.
    pub fn get_history(&self, token_id: String, from_seq: Option<u64>, limit: Option<u64>) -> Vec<StoredReceipt> {
        let Some(t) = self.tokens.get(&token_id) else { return vec![] };
        let top = from_seq.unwrap_or(t.receipts).min(t.receipts);
        let n = limit.unwrap_or(MAX_HISTORY_PAGE).min(MAX_HISTORY_PAGE);
        (1..=top).rev().take(n as usize).filter_map(|seq| self.receipts.get(&(token_id.clone(), seq)).cloned()).collect()
    }
}
