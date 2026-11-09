//! TrueNav paid query contract (NEAR testnet only). Build step 4, spec/v2/SPEC.md section 13; owner decisions of
//! 7 Nov: a separate account, a 0.01 testnet NEAR fee, a one-use entitlement valid 24 hours, admin-only withdraw
//! with an event. Q&A: at most 20 questions per entitlement.
//!
//! - `buy_query(request_id, query_hash, kind)`: an agent pays exactly the fee for an entitlement bound to one query
//!   (`query_hash` = sha256 hex of the query the API will serve, for example "report|DEMO-CREDIT"). Any other amount
//!   is refused before anything is stored, so the whole deposit goes back to the caller with the failed call.
//! - `redeem(request_id, query_hash)`: only the API's redeemer account; checks expiry, the bound query and the uses
//!   left, then spends one use. A report entitlement has 1 use; an ask entitlement has 20 (one per question).
//! - `withdraw(amount, receiver)`: admin only, never below the balance that pays for this contract's storage.
//!
//! This contract has no link to the receipt contract and no way to reach a score: a payment never changes any input
//! or output of a run. It holds only query fees. Everything stored here is public chain state (buyer account,
//! query hash, times, uses).
use near_sdk::json_types::{U128, U64};

use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{assert_one_yocto, env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise};

pub const EVENT_STANDARD: &str = "truenav-query";
pub const EVENT_VERSION: &str = "1.0.0";
pub const DAY_NS: u64 = 24 * 3600 * 1_000_000_000;
pub const REPORT_USES: u32 = 1;
pub const ASK_USES: u32 = 20;
/// kept on the account after any withdraw, on top of the storage it pays for
pub const RESERVE: NearToken = NearToken::from_millinear(500);

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Entitlements,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Entitlement {
    pub request_id: String,
    pub buyer: AccountId,
    pub kind: String,
    pub query_hash: String,
    pub paid: U128,
    pub created_ns: U64,
    pub expires_ns: U64,
    pub uses_left: u32,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Query {
    admin: AccountId,
    proposed_admin: Option<AccountId>,
    redeemer: AccountId,
    fee: NearToken,
    ttl_ns: u64,
    paused: bool,
    sold: u64,
    entitlements: LookupMap<String, Entitlement>,
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!("EVENT_JSON:{}", json!({ "standard": EVENT_STANDARD, "version": EVENT_VERSION, "event": event, "data": [data] })));
}
fn is_request_id(s: &str) -> bool {
    (8..=64).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}
fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

#[near]
impl Query {
    #[init]
    pub fn new(admin: AccountId, redeemer: AccountId, fee: U128) -> Self {
        require!(fee.0 > 0, "fee must be above 0");
        Self { admin, proposed_admin: None, redeemer, fee: NearToken::from_yoctonear(fee.0), ttl_ns: DAY_NS, paused: false, sold: 0, entitlements: LookupMap::new(Key::Entitlements) }
    }

    /// Admin calls carry exactly 1 yoctoNEAR, so they need a full-access key. `redeem` takes none, so the API can
    /// hold a function-call key limited to it.
    fn only_admin(&self) {
        require!(env::predecessor_account_id() == self.admin, "admin only");
        assert_one_yocto();
    }

    /// Pay exactly the fee for one entitlement. Refused (deposit returned with the failed call) for any other amount,
    /// a reused request_id, a malformed hash or an unknown kind.
    #[payable]
    pub fn buy_query(&mut self, request_id: String, query_hash: String, kind: String) -> Entitlement {
        require!(!self.paused, "paused");
        let paid = env::attached_deposit();
        require!(paid == self.fee, format!("attach exactly {} yoctoNEAR", self.fee.as_yoctonear()));
        require!(is_request_id(&request_id), "request_id must be 8 to 64 of [A-Za-z0-9_-]");
        require!(is_hex64(&query_hash), "query_hash must be 64 lowercase hex");
        let uses = match kind.as_str() {
            "report" => REPORT_USES,
            "ask" => ASK_USES,
            _ => env::panic_str("kind must be report or ask"),
        };
        require!(self.entitlements.get(&request_id).is_none(), "request_id already used");
        let now = env::block_timestamp();
        let e = Entitlement { request_id: request_id.clone(), buyer: env::predecessor_account_id(), kind, query_hash, paid: U128(paid.as_yoctonear()), created_ns: U64(now), expires_ns: U64(now + self.ttl_ns), uses_left: uses };
        self.entitlements.insert(request_id, e.clone());
        self.sold += 1;
        emit("query_bought", json!({ "request_id": e.request_id, "buyer": e.buyer, "kind": e.kind, "query_hash": e.query_hash, "paid": e.paid, "expires_ns": e.expires_ns }));
        e
    }

    /// The API spends one use of an entitlement for the query it is about to serve. Returns the uses left.
    pub fn redeem(&mut self, request_id: String, query_hash: String) -> u32 {
        require!(!self.paused, "paused");
        require!(env::predecessor_account_id() == self.redeemer, "redeemer only");
        let e = self.entitlements.get_mut(&request_id).unwrap_or_else(|| env::panic_str("unknown entitlement"));
        require!(env::block_timestamp() < e.expires_ns.0, "entitlement expired");
        require!(e.query_hash == query_hash, "entitlement is for another query");
        require!(e.uses_left > 0, "entitlement already used");
        e.uses_left -= 1;
        let left = e.uses_left;
        emit("entitlement_redeemed", json!({ "request_id": request_id, "uses_left": left }));
        left
    }

    /// Admin only. Never below the balance that pays for storage plus a fixed reserve.
    #[payable]
    pub fn withdraw(&mut self, amount: U128, receiver: AccountId) -> Promise {
        self.only_admin();
        let locked = (env::storage_usage() as u128) * env::storage_byte_cost().as_yoctonear() + RESERVE.as_yoctonear();
        let free = env::account_balance().as_yoctonear().saturating_sub(locked);
        require!(amount.0 > 0 && amount.0 <= free, format!("at most {free} yoctoNEAR can be withdrawn"));
        emit("withdraw", json!({ "amount": amount, "receiver": receiver, "by": self.admin }));
        Promise::new(receiver).transfer(NearToken::from_yoctonear(amount.0))
    }

    #[payable]
    pub fn set_fee(&mut self, fee: U128) {
        self.only_admin();
        require!(fee.0 > 0, "fee must be above 0");
        emit("fee_changed", json!({ "old": U128(self.fee.as_yoctonear()), "new": fee }));
        self.fee = NearToken::from_yoctonear(fee.0);
    }
    #[payable]
    pub fn set_redeemer(&mut self, account: AccountId) {
        self.only_admin();
        emit("redeemer_changed", json!({ "old": self.redeemer, "new": account }));
        self.redeemer = account;
    }
    #[payable]
    pub fn set_paused(&mut self, paused: bool) {
        self.only_admin();
        self.paused = paused;
        emit(if paused { "paused" } else { "unpaused" }, json!({ "by": self.admin }));
    }
    #[payable]
    pub fn propose_admin(&mut self, account: AccountId) {
        self.only_admin();
        self.proposed_admin = Some(account);
    }
    #[payable]
    pub fn accept_admin(&mut self) {
        let me = env::predecessor_account_id();
        require!(self.proposed_admin.as_ref() == Some(&me), "not the proposed admin");
        assert_one_yocto();
        emit("admin_changed", json!({ "old": self.admin, "new": me }));
        self.admin = me;
        self.proposed_admin = None;
    }

    pub fn get_entitlement(&self, request_id: String) -> Option<Entitlement> {
        self.entitlements.get(&request_id).cloned()
    }
    pub fn get_config(&self) -> near_sdk::serde_json::Value {
        json!({ "admin": self.admin, "redeemer": self.redeemer, "fee": U128(self.fee.as_yoctonear()), "ttl_ns": U64(self.ttl_ns), "paused": self.paused, "sold": self.sold, "report_uses": REPORT_USES, "ask_uses": ASK_USES })
    }
}
