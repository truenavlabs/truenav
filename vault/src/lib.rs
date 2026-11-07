//! TrueNav circuit breaker (owner decision D3, 7 Nov). Testnet only, demo deposits in NEAR.
//!
//! A fund-share vault that reads the fund's latest signed TrueNav certificate from the registry before it accepts
//! money. `subscribe` asks the registry for `get_latest_certificate(fund_id)`; the callback refuses the deposit and
//! refunds it in the same transaction when the certificate is missing, not scored, red, or older than `max_age_ms`.
//! Otherwise it mints demo shares 1:1 against the deposit. Every outcome is logged as a NEP-297 style event, so the
//! refusal is visible in the explorer. This is how a tokenized credit vault would plug the score in: the registry
//! only stores certificates whose signature it checked, so the vault trusts the registry and nothing else.
use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError};

/// The part of the registry's StoredCertificate the vault reads (other fields are ignored).
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct CertificateView {
    pub fund_id: String,
    pub status: String,
    pub score: Option<u8>,
    pub band: String,
    pub signed_at_ms: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct StoredCertificateView {
    pub certificate: CertificateView,
    pub signer: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Outcome {
    /// "subscribed" or "refused".
    pub outcome: String,
    /// Why a subscription was refused: "no certificate", "not scored", "red", "stale"; empty when subscribed.
    pub reason: String,
    pub band: String,
    pub score: Option<u8>,
    pub certificate_age_ms: u64,
    pub amount: U128,
}

/// 7 days, the same freshness window as the engine's 168-hour cash attestation rule.
pub const DEFAULT_MAX_AGE_MS: u64 = 7 * 24 * 3600 * 1000;
const VIEW_GAS: Gas = Gas::from_tgas(10);
const CALLBACK_GAS: Gas = Gas::from_tgas(15);

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    owner: AccountId,
    registry: AccountId,
    fund_id: String,
    max_age_ms: u64,
    shares: LookupMap<AccountId, u128>,
    total_shares: u128,
}

/// The circuit-breaker rule, kept pure so it is tested directly: Ok(()) to accept, Err(reason) to refuse.
pub fn check_certificate(cert: &Option<StoredCertificateView>, fund_id: &str, now_ms: u64, max_age_ms: u64) -> Result<(), &'static str> {
    let c = match cert {
        Some(s) => &s.certificate,
        None => return Err("no certificate"),
    };
    if c.fund_id != fund_id {
        return Err("no certificate");
    }
    if c.status != "scored" || c.score.is_none() {
        return Err("not scored");
    }
    if c.band == "red" {
        return Err("red");
    }
    if now_ms.saturating_sub(c.signed_at_ms) > max_age_ms {
        return Err("stale");
    }
    Ok(())
}

#[near]
impl Vault {
    #[init]
    pub fn new(registry: AccountId, fund_id: String, max_age_ms: Option<u64>) -> Self {
        Self { owner: env::predecessor_account_id(), registry, fund_id, max_age_ms: max_age_ms.unwrap_or(DEFAULT_MAX_AGE_MS), shares: LookupMap::new(b"s"), total_shares: 0 }
    }

    /// Deposit NEAR for demo fund shares. The vault first reads the fund's latest certificate from the registry.
    #[payable]
    pub fn subscribe(&mut self) -> Promise {
        let amount = env::attached_deposit();
        require!(amount >= NearToken::from_millinear(1), "attach at least 0.001 NEAR");
        Promise::new(self.registry.clone())
            .function_call("get_latest_certificate", format!("{{\"fund_id\":{}}}", near_sdk::serde_json::to_string(&self.fund_id).unwrap()).into_bytes(), NearToken::from_yoctonear(0), VIEW_GAS)
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_certificate(env::predecessor_account_id(), U128(amount.as_yoctonear())))
    }

    #[private]
    pub fn on_certificate(&mut self, investor: AccountId, amount: U128, #[callback_result] cert: Result<Option<StoredCertificateView>, PromiseError>) -> Outcome {
        let now = env::block_timestamp_ms();
        let cert = cert.unwrap_or(None);
        let (band, score, age) = match &cert {
            Some(s) => (s.certificate.band.clone(), s.certificate.score, now.saturating_sub(s.certificate.signed_at_ms)),
            None => (String::new(), None, 0),
        };
        match check_certificate(&cert, &self.fund_id, now, self.max_age_ms) {
            Ok(()) => {
                let held = self.shares.get(&investor).copied().unwrap_or(0);
                self.shares.insert(investor.clone(), held + amount.0);
                self.total_shares += amount.0;
                env::log_str(&format!("EVENT_JSON:{{\"standard\":\"truenav-vault\",\"version\":\"1.0.0\",\"event\":\"subscribed\",\"data\":[{{\"investor\":\"{investor}\",\"amount\":\"{}\",\"fund_id\":\"{}\",\"band\":\"{band}\",\"score\":{}}}]}}", amount.0, self.fund_id, score.map(|s| s.to_string()).unwrap_or("null".into())));
                Outcome { outcome: "subscribed".into(), reason: String::new(), band, score, certificate_age_ms: age, amount }
            }
            Err(reason) => {
                Promise::new(investor.clone()).transfer(NearToken::from_yoctonear(amount.0)).detach();
                env::log_str(&format!("EVENT_JSON:{{\"standard\":\"truenav-vault\",\"version\":\"1.0.0\",\"event\":\"refused\",\"data\":[{{\"investor\":\"{investor}\",\"amount\":\"{}\",\"fund_id\":\"{}\",\"reason\":\"{reason}\",\"band\":\"{band}\",\"refunded\":true}}]}}", amount.0, self.fund_id));
                Outcome { outcome: "refused".into(), reason: reason.into(), band, score, certificate_age_ms: age, amount }
            }
        }
    }

    /// Owner only: the oldest certificate the vault still accepts.
    #[payable]
    pub fn set_max_age_ms(&mut self, max_age_ms: u64) {
        near_sdk::assert_one_yocto();
        require!(env::predecessor_account_id() == self.owner, "owner only");
        require!(max_age_ms >= 1000, "max_age_ms must be at least 1000");
        self.max_age_ms = max_age_ms;
    }

    pub fn get_shares(&self, account_id: AccountId) -> U128 {
        U128(self.shares.get(&account_id).copied().unwrap_or(0))
    }

    pub fn get_config(&self) -> (AccountId, AccountId, String, u64, U128) {
        (self.owner.clone(), self.registry.clone(), self.fund_id.clone(), self.max_age_ms, U128(self.total_shares))
    }
}
