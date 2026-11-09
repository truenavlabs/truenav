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
pub mod attestations;
pub mod mirror;
pub mod v3;
pub mod validate;

use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::{IterableMap, IterableSet, LookupMap};
use near_sdk::{
    assert_one_yocto, env, near, require, AccountId, BorshStorageKey, Gas, NearToken,
    PanicOnDefault, Promise, PromiseError, PromiseOrValue,
};
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

/// A cleared request whose OutLayer callback may still arrive: who to refund, the OutLayer deposit it forwarded,
/// and this record's own storage cost. Stored under late_key(request_id), outside the contract struct.
#[derive(BorshSerialize, BorshDeserialize)]
#[borsh(crate = "near_sdk::borsh")]
struct Late {
    requester: AccountId,
    outlayer_deposit: U128,
    held: U128,
}
/// The least gas on_run_result is given (Config.callback_tgas). A large OutLayer result does not cost this callback
/// per byte today: near-vm-runner 0.38 puts a successful promise result into the register by reference
/// (set_rc_data, no write_register_byte charge; the sender already paid for the bytes), and near-sdk's
/// promise_result_checked compares the register length with the limit before copying anything into wasm memory.
/// Measured: the same gas for a 0 byte and a 4 MiB result in the unit-test VM, and for 1 and 2 MiB on the sandbox.
/// The floor is a guard in case a protocol ever charges those bytes: max_length_returned_data 4,194,304 bytes x
/// wasm_write_register_byte 3,801,564 gas = 15.95 Tgas, plus the callback's own work (about 2 Tgas for a late
/// callback, more for storing a 10 KB receipt), with room to spare, so a huge result can never exhaust the gas and
/// roll back the removal of the pending or late record. The deployed config uses 50.
pub const MIN_CALLBACK_TGAS: u64 = 40;
/// Bound on registered tokens. The case-collision scan walks this set.
pub const MAX_TOKENS: u32 = 64;

fn late_key(request_id: u64) -> Vec<u8> {
    [b"late:".as_slice(), &request_id.to_le_bytes()].concat()
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
    /// the method in force when the request was made; the receipt must claim exactly this one
    pub method: String,
    pub storage_deposit: U128,
    /// what was forwarded to OutLayer with this request
    pub outlayer_deposit: U128,
    /// storage bytes this pending record took, measured when it was written; charged to the requester
    pub pending_bytes: u64,
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
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": EVENT_STANDARD, "version": EVENT_VERSION, "event": event, "data": [data] })
    ));
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
const PUBLIC_RECEIPT_KEYS: &[&str] = &[
    "as_of",
    "band",
    "caps",
    "checks_run",
    "evidence_hashes",
    "error",
    "exceptions",
    "head_status",
    "holds",
    "kind",
    "method",
    "passport",
    "method_version",
    "engine_version_key",
    "period",
    "receipt_sha256",
    "receipt_version",
    "run_nonce",
    "score",
    "seq",
    "synthetic",
    "token_id",
    "version_key",
    "method_spec_sha256",
    "network",
    "receipts_contract",
    "currency",
    "engine_code_sha256",
    "fund_id",
    "fund_account",
    "period_start",
    "period_end",
    "prev_receipt_sha256",
    "supersedes_seq",
    "correction_reason_code",
    "issued_at",
    "data_as_of",
    "valuation_time",
    "request_id",
    "request_nonce",
    "input_sha256",
    "attestation_ref",
    "source_key_ids",
    "commitments",
    "pledge_scope",
    "fingerprint_scheme",
    "pledge_result",
    "pledge_coverage_bps",
    "loans_checked",
    "blocked_attempts",
    "blocked_attempts_window",
    "lien_support",
    "reported_nav",
    "trueval",
    "truerange_low",
    "truerange_high",
    "nav_result",
    "nav_gap_band",
    "unverified_share_band",
    "cash_evidence_status",
    "cash_match_band",
    "yield_gap_band",
    "collection_rate_band",
    "late_share_band",
    "late_loan_cohorts",
    "status",
    "parts_band",
    "freshness_band",
    "ext",
];
fn public_codes(v: &Value) -> Value {
    let Some(xs) = v.as_array() else {
        return Value::Array(vec![]);
    };
    Value::Array(
        xs.iter()
            .filter_map(|x| {
                x.get("code")
                    .and_then(Value::as_str)
                    .map(|s| Value::String(s.to_string()))
                    .or_else(|| x.as_str().map(|s| Value::String(s.to_string())))
            })
            .collect(),
    )
}
fn project_public(v: &Value) -> Value {
    let Some(obj) = v.as_object() else {
        return v.clone();
    };
    let mut out = serde_json::Map::new();
    for key in PUBLIC_RECEIPT_KEYS {
        let Some(value) = obj.get(*key) else {
            continue;
        };
        let next = if *key == "caps" || *key == "holds" {
            public_codes(value)
        } else {
            value.clone()
        };
        out.insert((*key).to_string(), next);
    }
    Value::Object(out)
}
impl Receipts {
    pub(crate) fn latest_raw(&self, token_id: &str) -> Option<StoredReceipt> {
        let n = self.tokens.get(token_id)?.receipts;
        if n == 0 {
            return None;
        }
        self.receipts.get(&(token_id.to_string(), n)).cloned()
    }
    pub(crate) fn head_failed(&self, token_id: &str) -> bool {
        self.failures.get(token_id).is_some()
    }
}
fn redact_public_receipt(raw: &str) -> String {
    let Ok(v) = serde_json::from_str::<Value>(raw) else {
        return raw.to_string();
    };
    if !v.is_object() {
        return raw.to_string();
    }
    project_public(&v).to_string()
}
fn check_config(c: &Config) {
    require!(
        !c.project_id.is_empty() && c.project_id.len() <= 128,
        "bad project_id"
    );
    require!(
        c.version_key.len() == 64
            && c.version_key
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "version_key must be a 64-hex wasm hash, never latest"
    );
    require!(
        c.method.starts_with("cashflow-v2.") || truenav_v3_core::wire::is_v3_method(&c.method),
        "unknown method"
    );
    require!(
        !c.secrets_profile.is_empty() && c.secrets_profile.len() <= 64,
        "bad secrets_profile"
    );
    require!(
        c.outlayer.as_str() == "outlayer.testnet",
        "outlayer account is not the allowlisted worker"
    );
    require!(
        c.outlayer_tgas + c.callback_tgas <= 290,
        "gas above 290 Tgas"
    );
    require!(
        c.callback_tgas >= MIN_CALLBACK_TGAS && c.outlayer_tgas >= 50,
        "gas too low"
    );
    // a receipt is at most MAX_RECEIPT_BYTES; the stored record roughly doubles it with its index fields, and the
    // pending record and a failure record come on top
    let extra = if truenav_v3_core::wire::is_v3_method(&c.method) {
        8_000
    } else {
        2_000
    };
    let worst = (2 * MAX_RECEIPT_BYTES as u128 + extra) * env::storage_byte_cost().as_yoctonear();
    require!(
        c.storage_deposit.0 >= worst,
        "storage_deposit too low for the largest receipt"
    );
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
    /// Admin calls carry exactly 1 yoctoNEAR, so they need a full-access key (as in the v1 contract).
    fn only_admin(&self) {
        require!(env::predecessor_account_id() == self.admin, "admin only");
        assert_one_yocto();
    }
    fn only_pauser_or_admin(&self) -> AccountId {
        let me = env::predecessor_account_id();
        require!(
            me == self.pauser || me == self.admin,
            "pauser or admin only"
        );
        assert_one_yocto();
        me
    }
    #[payable]
    pub fn propose_admin(&mut self, account: AccountId) {
        self.only_admin();
        self.proposed_admin = Some(account);
    }
    #[payable]
    pub fn accept_admin(&mut self) {
        let me = env::predecessor_account_id();
        require!(
            self.proposed_admin.as_ref() == Some(&me),
            "not the proposed admin"
        );
        assert_one_yocto();
        emit("admin_changed", json!({ "old": self.admin, "new": me }));
        self.admin = me;
        self.proposed_admin = None;
    }
    #[payable]
    pub fn set_pauser(&mut self, account: AccountId) {
        self.only_admin();
        self.pauser = account;
    }
    #[payable]
    pub fn set_runner(&mut self, account: AccountId, allowed: bool) {
        self.only_admin();
        if allowed {
            self.runners.insert(account.clone());
        } else {
            self.runners.remove(&account);
        }
        emit(
            "runner_set",
            json!({ "account": account, "allowed": allowed }),
        );
    }
    #[payable]
    pub fn pause(&mut self) {
        let me = self.only_pauser_or_admin();
        self.paused = true;
        emit("paused", json!({ "by": me }));
    }
    #[payable]
    pub fn unpause(&mut self) {
        let me = self.only_pauser_or_admin();
        self.paused = false;
        emit("unpaused", json!({ "by": me }));
    }
    /// Change how runs are requested, including the pinned build. Pending requests keep the build they pinned.
    #[payable]
    pub fn set_config(&mut self, config: Config) {
        self.only_admin();
        check_config(&config);
        require!(
            !v3::enabled() || config.method == truenav_v3_core::wire::CURRENT_METHOD,
            "v3 migration forbids v2 writes"
        );
        emit(
            "config_changed",
            json!({ "old_version_key": self.config.version_key, "new_version_key": config.version_key, "method": config.method }),
        );
        self.config = config;
    }
    #[payable]
    pub fn register_token(&mut self, token_id: String, kind: String) {
        self.only_admin();
        require!(
            is_token_id(&token_id),
            "token_id must match ASCII kebab segments, 1 to 64 characters"
        );
        require!(
            self.tokens
                .values()
                .all(|t| t.token_id == token_id || !t.token_id.eq_ignore_ascii_case(&token_id)),
            "token_id case collision"
        );
        require!(
            kind == "credit" || kind == "rental",
            "kind must be credit or rental"
        );
        require!(
            self.tokens.get(&token_id).is_none(),
            "token already registered"
        );
        require!(self.tokens.len() < MAX_TOKENS, "token limit");
        self.tokens.insert(
            token_id.clone(),
            TokenInfo {
                token_id: token_id.clone(),
                kind: kind.clone(),
                receipts: 0,
                registered_ns: env::block_timestamp(),
            },
        );
        emit(
            "token_registered",
            json!({ "token_id": token_id, "kind": kind }),
        );
    }
    /// Drop a pending request whose callback never arrived (OutLayer's yield always resumes or times out, so this
    /// is a last resort). Its storage deposit goes back to the requester, less the few bytes of a late-callback
    /// record (requester, OutLayer deposit): if the callback does arrive later and the OutLayer promise FAILED, the
    /// requester is refunded the OutLayer deposit then, exactly once, with those bytes (on_run_result). The record
    /// lives under its own raw key, outside the contract struct, so the state layout is unchanged.
    #[payable]
    pub fn clear_pending(&mut self, token_id: String) -> Promise {
        self.only_admin();
        let p = self
            .pending
            .remove(&token_id)
            .unwrap_or_else(|| env::panic_str("no pending request"));
        self.pending.flush();
        v3::clear_context(p.request_id);
        let s0 = env::storage_usage();
        let mut late = Late {
            requester: p.requester.clone(),
            outlayer_deposit: p.outlayer_deposit,
            held: U128(0),
        };
        env::storage_write(
            &late_key(p.request_id),
            &borsh::to_vec(&late).unwrap_or_default(),
        );
        // the record's own bytes (a u128 field keeps the same size when `held` is filled in)
        late.held = U128(
            (env::storage_usage().saturating_sub(s0) as u128)
                * env::storage_byte_cost().as_yoctonear(),
        );
        env::storage_write(
            &late_key(p.request_id),
            &borsh::to_vec(&late).unwrap_or_default(),
        );
        emit(
            "pending_cleared",
            json!({ "token_id": token_id, "request_id": p.request_id }),
        );
        Promise::new(p.requester).transfer(NearToken::from_yoctonear(
            p.storage_deposit.0.saturating_sub(late.held.0),
        ))
    }

    // ---- runs --------------------------------------------------------------------------------------------------
    #[payable]
    pub fn request_run(&mut self, token_id: String) -> PromiseOrValue<Value> {
        require!(!self.paused, "paused");
        let requester = env::predecessor_account_id();
        require!(self.runners.contains(&requester), "runner only");
        require!(self.tokens.get(&token_id).is_some(), "unknown token");
        require!(
            self.pending.get(&token_id).is_none(),
            "a run is already pending for this token"
        );
        let c = self.config.clone();
        require!(
            !v3::enabled() || c.method == truenav_v3_core::wire::CURRENT_METHOD,
            "v3 migration forbids v2 writes"
        );
        let need = c.outlayer_deposit.0 + c.storage_deposit.0;
        let attached = env::attached_deposit().as_yoctonear();
        require!(
            attached >= need,
            format!("attach at least {need} yoctoNEAR")
        );
        require!(
            env::prepaid_gas().as_tgas() >= c.outlayer_tgas + c.callback_tgas + 10,
            "not enough gas"
        );

        // Validate before reserving a nonce or pending state. Return the entire deposit
        // on a corrupt stored head; no OutLayer request is created.
        if let Some(last) = self.latest_raw(&token_id) {
            if !matches!(
                serde_json::from_str::<Value>(&last.receipt),
                Ok(Value::Object(_))
            ) {
                let code = if truenav_v3_core::wire::is_v3_method(&last.method) {
                    "v3_receipt_corrupt"
                } else {
                    "v2_receipt_corrupt"
                };
                self.failures.insert(
                    token_id.clone(),
                    Failure {
                        request_id: self.next_request,
                        code: code.into(),
                        at_ns: env::block_timestamp(),
                    },
                );
                if attached > 0 {
                    Promise::new(requester)
                        .transfer(NearToken::from_yoctonear(attached))
                        .detach();
                }
                return PromiseOrValue::Value(json!({
                    "error": code,
                    "head_status": "failed"
                }));
            }
        }

        let request_id = self.next_request;
        self.next_request += 1;
        let mut seed = env::random_seed();
        seed.extend_from_slice(&request_id.to_le_bytes());
        seed.extend_from_slice(token_id.as_bytes());
        let run_nonce = hex(&env::sha256(&seed));
        // measure what the pending record costs (store collections write on flush): it is charged to the requester
        // only the pending map is flushed in this call, so only its own writes move storage_usage here
        self.pending.flush();
        let s0 = env::storage_usage();
        let mut pending = Pending {
            request_id,
            token_id: token_id.clone(),
            run_nonce: run_nonce.clone(),
            requester: requester.clone(),
            version_key: c.version_key.clone(),
            method: c.method.clone(),
            outlayer_deposit: c.outlayer_deposit,
            storage_deposit: c.storage_deposit,
            pending_bytes: 0,
            requested_ns: env::block_timestamp(),
        };
        self.pending.insert(token_id.clone(), pending.clone());
        self.pending.flush();
        if truenav_v3_core::wire::is_v3_method(&c.method) {
            self.reserve_v3(&pending);
        }
        pending.pending_bytes = env::storage_usage().saturating_sub(s0);
        self.pending.insert(token_id.clone(), pending);
        // The whole input is built here, never taken from the caller: token_id (checked as registered above), this
        // contract's nonce, and, from this contract's own last stored receipt for the token, the previous passport
        // and period (the TEE compares that period with the issuer's to decide whether a new period started, for the
        // carried-forward check). No as_of: the receipt's as_of is the TEE clock.
        let input = self.run_input(&token_id, &run_nonce).to_string();
        let args = json!({
            "source": { "Project": { "project_id": c.project_id, "version_key": c.version_key } },
            "resource_limits": { "max_instructions": c.max_instructions, "max_memory_mb": c.max_memory_mb, "max_execution_seconds": c.max_execution_seconds },
            "input_data": input,
            "secrets_ref": { "profile": c.secrets_profile, "account_id": c.secrets_owner },
            "response_format": "Json",
            "payer_account_id": requester,
            "params": null,
        });
        emit(
            "run_requested",
            json!({ "token_id": token_id, "request_id": request_id, "run_nonce": run_nonce, "version_key": c.version_key, "method": c.method }),
        );
        if attached > need {
            Promise::new(requester)
                .transfer(NearToken::from_yoctonear(attached - need))
                .detach();
        }
        PromiseOrValue::Promise(
            Promise::new(c.outlayer.clone())
                .function_call(
                    "request_execution",
                    args.to_string().into_bytes(),
                    NearToken::from_yoctonear(c.outlayer_deposit.0),
                    Gas::from_tgas(c.outlayer_tgas),
                )
                .then(
                    Promise::new(env::current_account_id()).function_call(
                        "on_run_result",
                        json!({ "token_id": token_id, "request_id": request_id })
                            .to_string()
                            .into_bytes(),
                        NearToken::from_yoctonear(0),
                        Gas::from_tgas(c.callback_tgas),
                    ),
                ),
        )
    }

    fn run_input(&self, token_id: &str, run_nonce: &str) -> Value {
        if self.config.method == truenav_v3_core::wire::CURRENT_METHOD {
            return self.v3_run_input(token_id, run_nonce);
        }
        let mut input = json!({ "token_id": token_id, "run_nonce": run_nonce });
        if let Some(last) = self.latest_raw(token_id) {
            // stored receipts passed validate.rs, so the passport entries have these fields
            let rec: Value = serde_json::from_str(&last.receipt).unwrap_or(Value::Null);
            let previous: Vec<Value> = rec["passport"].as_array().map(|ps| ps.iter().map(|p| json!({ "source": p["source"], "snapshot_sha256": p["snapshot_sha256"], "as_of": p["as_of"] })).collect()).unwrap_or_default();
            if !previous.is_empty() {
                input["previous"] = json!(previous);
                input["previous_period"] = json!(last.period);
            }
        }
        input
    }

    fn flush_all(&mut self) {
        self.pending.flush();
        self.receipts.flush();
        self.failures.flush();
        self.tokens.flush();
    }

    /// OutLayer's outcomes (outlayer.testnet contract/src/execution.rs, read 8 Nov): once a request is admitted,
    /// on_execution_response always returns a value: the guest's JSON, or `null` when the run failed or timed out,
    /// and OutLayer itself refunds the unused deposit to `payer_account_id`. A FAILED promise therefore means
    /// request_execution panicked at admission: NEAR returned the attached deposit to this contract, so it is passed
    /// on to the requester here. A `null` result refunds nothing more (OutLayer already did), so nothing is refunded
    /// twice. A FAILED promise can in principle also come from OutLayer's own callback panicking after admission; it
    /// returns a value on every path, so this should not happen, and it cannot be told apart here: it would be
    /// treated as an admission failure, refunding 0.01 NEAR from this contract's balance (README, failures and
    /// refunds). This callback must not panic: a panic would roll back the pending removal.
    /// A callback for a request the admin already cleared: refund its requester once, from the late-callback record
    /// clear_pending left. A FAILED OutLayer promise refunds the OutLayer deposit (the same rule as in flight); any
    /// other outcome refunds only the record's bytes, and the late receipt is not stored. No record (never cleared,
    /// or already refunded): nothing is refunded.
    fn late_callback(&mut self, token_id: &str, request_id: u64, none: &str) -> String {
        let key = late_key(request_id);
        let Some(raw) = env::storage_read(&key) else {
            return none.into();
        };
        env::storage_remove(&key);
        let Ok(late) = borsh::from_slice::<Late>(&raw) else {
            return none.into();
        };
        let failed = matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed));
        let refund = late.held.0 + if failed { late.outlayer_deposit.0 } else { 0 };
        if refund > 0 {
            Promise::new(late.requester)
                .transfer(NearToken::from_yoctonear(refund))
                .detach();
        }
        let code = if failed {
            "late_refunded"
        } else {
            "late_ignored"
        };
        emit(
            "late_callback",
            json!({ "token_id": token_id, "request_id": request_id, "code": code, "refund": U128(refund) }),
        );
        code.into()
    }

    #[private]
    pub fn on_run_result(&mut self, token_id: String, request_id: u64) -> String {
        let Some(p) = self.pending.get(&token_id).cloned() else {
            return self.late_callback(&token_id, request_id, "no_pending");
        };
        if p.request_id != request_id {
            return self.late_callback(&token_id, request_id, "stale_callback");
        }
        self.flush_all();
        self.pending.remove(&token_id);
        self.pending.flush();
        // from here on everything this run stores is charged, on top of the pending record's own bytes
        let before = env::storage_usage();
        let mut deposit_back = 0u128;
        // read at most MAX_RECEIPT_BYTES, so an oversized result cannot run the callback out of gas
        let outcome = match env::promise_result_checked(0, MAX_RECEIPT_BYTES) {
            Ok(bytes) => self.accept(&p, &bytes),
            Err(PromiseError::TooLong(_)) => Err("receipt_too_large".to_string()),
            Err(_) => {
                deposit_back = self.config_outlayer_deposit_for(&p);
                Err("outlayer_admission_failed".to_string())
            }
        };
        v3::clear_context(p.request_id);
        let code = match outcome {
            Ok(seq) => format!("stored:{seq}"),
            Err(code) => {
                if p.storage_deposit.0 >= 4096 * env::storage_byte_cost().as_yoctonear() {
                    self.failures.insert(
                        token_id.clone(),
                        Failure {
                            request_id,
                            code: code.clone(),
                            at_ns: env::block_timestamp(),
                        },
                    );
                }
                emit(
                    "run_failed",
                    json!({ "token_id": token_id, "request_id": request_id, "code": code }),
                );
                code
            }
        };
        // store collections write on flush: flush now so the measured storage includes what this run stored
        self.flush_all();
        let added = env::storage_usage().saturating_sub(before);
        let charged = ((p.pending_bytes + added) as u128) * env::storage_byte_cost().as_yoctonear();
        let refund = p.storage_deposit.0.saturating_sub(charged) + deposit_back;
        if refund > 0 {
            Promise::new(p.requester)
                .transfer(NearToken::from_yoctonear(refund))
                .detach();
        }
        code
    }

    /// The OutLayer deposit this request forwarded (snapshotted: the config may have changed since).
    fn config_outlayer_deposit_for(&self, p: &Pending) -> u128 {
        p.outlayer_deposit.0
    }

    fn accept(&mut self, p: &Pending, bytes: &[u8]) -> Result<u64, String> {
        if bytes.len() > MAX_RECEIPT_BYTES {
            return Err("receipt_too_large".into());
        }
        let v: Value = truenav_v3_core::parse(bytes).map_err(|_| "receipt_not_json".to_string())?;
        if truenav_v3_core::wire::is_v3_method(&p.method) {
            return self.accept_v3(p, &v);
        }
        if v3::enabled() {
            return Err("v2_writes_disabled".into());
        }
        match &v {
            // OutLayer's answer for an admitted run that failed or timed out; it already refunded the payer
            Value::Null => return Err("outlayer_run_failed".into()),
            // response_format Json delivers the guest's JSON object; anything else (a JSON string holding JSON, an
            // array, a number) is refused rather than reinterpreted, so a stored receipt is always the object
            Value::Object(_) => {}
            _ => return Err("receipt_not_object".into()),
        }
        if let Some(stage) = v.get("error").and(v.get("stage")).and_then(Value::as_str) {
            return Err(if is_stage(stage) {
                format!("module_failed:{stage}")
            } else {
                "module_failed".into()
            });
        }
        let token = self
            .tokens
            .get(&p.token_id)
            .cloned()
            .ok_or("unknown_token")?;
        let s = check(
            &v,
            &Expect {
                method: &p.method,
                token_id: &p.token_id,
                kind: &token.kind,
                run_nonce: &p.run_nonce,
            },
        )?;
        let seq = token.receipts + 1;
        let receipt =
            String::from_utf8(bytes.to_vec()).map_err(|_| "receipt_not_utf8".to_string())?;
        let sha = hex(&env::sha256(bytes));
        emit(
            "receipt_stored",
            json!({ "token_id": p.token_id, "seq": seq, "request_id": p.request_id, "score": s.score, "band": s.band, "caps": s.caps, "holds": s.holds, "method": p.method, "version_key": p.version_key, "receipt_sha256": sha }),
        );
        self.receipts.insert(
            (p.token_id.clone(), seq),
            StoredReceipt {
                token_id: p.token_id.clone(),
                seq,
                request_id: p.request_id,
                method: p.method.clone(),
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
    /// What the next request for this token would send as input_data (with a placeholder nonce): every field is
    /// built by this contract, none comes from the caller.
    pub fn get_run_input(&self, token_id: String) -> Value {
        self.run_input(&token_id, "<made at request time>")
    }
    pub fn is_runner(&self, account: AccountId) -> bool {
        self.runners.contains(&account)
    }
    pub fn get_token(&self, token_id: String) -> Option<Value> {
        let t = self.tokens.get(&token_id)?;
        Some(
            json!({ "token": t, "pending": self.pending.get(&token_id), "last_failure": self.failures.get(&token_id) }),
        )
    }
    pub fn list_tokens(&self, from: Option<u64>, limit: Option<u64>) -> Vec<TokenInfo> {
        self.tokens
            .values()
            .skip(from.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize)
            .cloned()
            .collect()
    }
    pub fn get_latest(&self, token_id: String) -> Option<StoredReceipt> {
        let mut r = self.latest_raw(&token_id)?;
        if self.head_failed(&token_id) {
            r.band = "red".into();
            r.score = 0;
            r.caps.clear();
            r.holds.clear();
            if let Ok(mut v) = serde_json::from_str::<Value>(&r.receipt) {
                if let Some(o) = v.as_object_mut() {
                    for key in [
                        "score",
                        "uncapped_score",
                        "raw_score",
                        "score_x100",
                        "parts_x100",
                        "trueval",
                        "reported_nav",
                        "parts_band",
                        "truerange_low",
                        "truerange_high",
                        "pledge_result",
                        "pledge_coverage_bps",
                        "collection_rate_band",
                    ] {
                        if o.contains_key(key) {
                            o.insert(key.to_string(), Value::Null);
                        }
                    }
                    o.insert("score".into(), Value::Null);
                    o.insert("caps".into(), json!([]));
                    o.insert("holds".into(), json!([]));
                    o.insert("head_status".into(), json!("failed"));
                    o.insert("band".into(), json!("red"));
                }
                r.receipt = v.to_string();
            }
        }
        r.receipt = redact_public_receipt(&r.receipt);
        Some(r)
    }
    /// Explicit version tag. Historical v2 wrapper fields are unchanged; v3 is the complete envelope.
    pub fn get_receipt(&self, token_id: String, seq: u64) -> Option<Value> {
        let r = self.receipts.get(&(token_id, seq))?;
        if truenav_v3_core::wire::is_v3_method(&r.method) {
            let v = serde_json::from_str::<Value>(&r.receipt)
                .unwrap_or_else(|_| json!({"receipt_version":"3","error":"v3_receipt_corrupt"}));
            return Some(if v.is_object() { project_public(&v) } else { v });
        }
        let mut v = serde_json::to_value(r).ok()?;
        if let Some(raw) = v.get("receipt").and_then(Value::as_str) {
            v["receipt"] = json!(redact_public_receipt(raw));
        }
        v["receipt_version"] = json!("2");
        Some(v)
    }
    /// Newest first, from `from_seq` (default the latest) down, at most 10 per page.
    pub fn get_history(
        &self,
        token_id: String,
        from_seq: Option<u64>,
        limit: Option<u64>,
    ) -> Vec<StoredReceipt> {
        let Some(t) = self.tokens.get(&token_id) else {
            return vec![];
        };
        let top = from_seq.unwrap_or(t.receipts).min(t.receipts);
        let n = limit.unwrap_or(MAX_HISTORY_PAGE).min(MAX_HISTORY_PAGE);
        (1..=top)
            .rev()
            .take(n as usize)
            .filter_map(|seq| {
                let mut r = self.receipts.get(&(token_id.clone(), seq))?.clone();
                r.receipt = redact_public_receipt(&r.receipt);
                Some(r)
            })
            .collect()
    }
}
