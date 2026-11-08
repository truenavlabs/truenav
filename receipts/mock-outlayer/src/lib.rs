//! Local sandbox stand-in for `outlayer.testnet` (test only, never deployed to testnet). `request_execution` has the
//! argument shape the receipt contract sends and parks the request with a yield, as OutLayer does; a worker (the
//! test harness, running the engine natively) reads `get_requests` and calls `resolve` with the module's output,
//! which resumes the yield. Like OutLayer's on_execution_response (contract/src/execution.rs): the callback returns
//! the output bytes as they are (response_format Json), or `null` when the run failed or timed out, and then refunds
//! the deposit to `payer_account_id`. `set_refuse(true)` makes request_execution panic at admission, so the caller
//! sees a failed promise and NEAR returns the deposit to the caller. It records each request's arguments so the
//! harness can check what went on chain.
use near_sdk::serde_json::{self, Value};
use near_sdk::store::IterableMap;
use near_sdk::{env, near, require, AccountId, CryptoHash, Gas, GasWeight, NearToken, PanicOnDefault, Promise};

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Request {
    pub request_id: u64,
    pub sender: AccountId,
    pub payer: String,
    pub source: String,
    pub input_data: String,
    pub secrets_ref: String,
    pub deposit: String,
    #[serde(skip)]
    pub data_id: Vec<u8>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Mock {
    worker: AccountId,
    next: u64,
    open: IterableMap<u64, Request>,
    /// outputs waiting for their yield callback: a resume payload is limited to 1024 bytes, so (like OutLayer,
    /// "Retrieving large output from storage") the output is parked here and the resume carries only a marker
    outputs: IterableMap<u64, String>,
    /// who to refund, and how much, when a run fails
    refunds: IterableMap<u64, (AccountId, u128)>,
    refuse: bool,
    /// test only: make on_resolved panic, so the caller's callback sees a FAILED promise after admission (the
    /// non-admission failure: OutLayer's own callback failing, the deposit kept)
    panic_on_resolve: bool,
}

#[near]
impl Mock {
    #[init]
    pub fn new(worker: AccountId) -> Self {
        Self { worker, next: 1, open: IterableMap::new(b"o"), outputs: IterableMap::new(b"x"), refunds: IterableMap::new(b"r"), refuse: false, panic_on_resolve: false }
    }

    #[payable]
    pub fn request_execution(&mut self, source: Value, resource_limits: Value, input_data: String, secrets_ref: Value, response_format: String, payer_account_id: String, params: Value) {
        let _ = (resource_limits, params);
        require!(!self.refuse, "request refused at admission");
        require!(response_format == "Json", "mock supports Json only");
        let payer: AccountId = payer_account_id.parse().unwrap_or_else(|_| env::panic_str("bad payer_account_id"));
        let id = self.next;
        self.next += 1;
        let idx = env::promise_yield_create("on_resolved", serde_json::json!({ "request_id": id }).to_string(), Gas::from_tgas(20), GasWeight(1), 0);
        let data_id = env::read_register(0).expect("yield data id");
        self.refunds.insert(id, (payer, env::attached_deposit().as_yoctonear()));
        self.open.insert(id, Request { request_id: id, sender: env::predecessor_account_id(), payer: payer_account_id, source: source.to_string(), input_data, secrets_ref: secrets_ref.to_string(), deposit: env::attached_deposit().as_yoctonear().to_string(), data_id });
        env::promise_return(idx);
    }

    /// Worker only: refuse (panic in) request_execution from now on, or stop refusing.
    pub fn set_refuse(&mut self, refuse: bool) {
        require!(env::predecessor_account_id() == self.worker, "worker only");
        self.refuse = refuse;
    }

    /// Worker only: make on_resolved panic from now on (a FAILED promise after admission), or stop.
    pub fn set_panic_on_resolve(&mut self, panic: bool) {
        require!(env::predecessor_account_id() == self.worker, "worker only");
        self.panic_on_resolve = panic;
    }

    /// Worker only: deliver the module output (or a failure) for one open request.
    pub fn resolve(&mut self, request_id: u64, success: bool, output: String) {
        require!(env::predecessor_account_id() == self.worker, "worker only");
        let r = self.open.remove(&request_id).expect("unknown request");
        let id: CryptoHash = r.data_id.try_into().expect("data id");
        if success {
            self.outputs.insert(request_id, output);
        }
        let marker = if success { "OK" } else { "FAILED" };
        require!(env::promise_yield_resume(&id, marker.as_bytes()), "yield already timed out");
    }

    #[private]
    pub fn on_resolved(&mut self, request_id: u64) {
        if self.panic_on_resolve {
            env::panic_str("mock: callback failed after admission");
        }
        let ok = matches!(env::promise_result_checked(0, 16), Ok(b) if b == b"OK");
        let refund = self.refunds.remove(&request_id);
        match self.outputs.remove(&request_id) {
            Some(out) if ok => env::value_return(out.as_bytes()),
            _ => {
                // failed or timed out: refund the payer, return null (OutLayer keeps a base fee; the mock keeps none)
                if let Some((payer, amount)) = refund.filter(|r| r.1 > 0) {
                    Promise::new(payer).transfer(NearToken::from_yoctonear(amount)).detach();
                }
                env::value_return(b"null");
            }
        }
    }

    pub fn get_requests(&self) -> Vec<Request> {
        self.open.values().cloned().collect()
    }
}
