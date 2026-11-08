//! Local sandbox stand-in for `outlayer.testnet` (test only, never deployed to testnet). `request_execution` has the
//! argument shape the receipt contract sends and parks the request with a yield, as OutLayer does; a worker (the
//! test harness, running the engine natively) reads `get_requests` and calls `resolve` with the module's output,
//! which resumes the yield. The resumed value is the output JSON (response_format Json), or a failed promise when
//! `success` is false. It records each request's arguments so the harness can check what went on chain.
use near_sdk::serde_json::{self, Value};
use near_sdk::store::IterableMap;
use near_sdk::{env, near, require, AccountId, CryptoHash, Gas, GasWeight, PanicOnDefault};

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
}

#[near]
impl Mock {
    #[init]
    pub fn new(worker: AccountId) -> Self {
        Self { worker, next: 1, open: IterableMap::new(b"o"), outputs: IterableMap::new(b"x") }
    }

    #[payable]
    pub fn request_execution(&mut self, source: Value, resource_limits: Value, input_data: String, secrets_ref: Value, response_format: String, payer_account_id: String, params: Value) {
        let _ = (resource_limits, params);
        require!(response_format == "Json", "mock supports Json only");
        let id = self.next;
        self.next += 1;
        let idx = env::promise_yield_create("on_resolved", serde_json::json!({ "request_id": id }).to_string(), Gas::from_tgas(20), GasWeight(1), 0);
        let data_id = env::read_register(0).expect("yield data id");
        self.open.insert(id, Request { request_id: id, sender: env::predecessor_account_id(), payer: payer_account_id, source: source.to_string(), input_data, secrets_ref: secrets_ref.to_string(), deposit: env::attached_deposit().as_yoctonear().to_string(), data_id });
        env::promise_return(idx);
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
    pub fn on_resolved(&mut self, request_id: u64) -> Value {
        let marker = match env::promise_result_checked(0, 16) {
            Ok(b) => b,
            Err(_) => env::panic_str("execution timed out"),
        };
        if marker != b"OK" {
            env::panic_str("execution failed");
        }
        let out = self.outputs.remove(&request_id).unwrap_or_else(|| env::panic_str("output missing"));
        serde_json::from_str(&out).unwrap_or_else(|_| env::panic_str("output is not JSON"))
    }

    pub fn get_requests(&self) -> Vec<Request> {
        self.open.values().cloned().collect()
    }
}
