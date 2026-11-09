use serde_json::{json, Value};
use std::cell::RefCell;
use truenav_engine_v3::rpc::*;
use truenav_v3_core::Result;
struct Mock {
    calls: RefCell<Vec<Value>>,
    wrong_block: bool,
}
impl Transport for Mock {
    fn post_json(&self, v: &Value) -> Result<Value> {
        self.calls.borrow_mut().push(v.clone());
        match v["method"].as_str() {
            Some("block") => {
                assert_eq!(v["params"]["finality"], "final");
                Ok(json!({"result":{"header":{"height":123,"hash":"TEST_finalized"}}}))
            }
            Some("query") => {
                assert_eq!(v["params"]["account_id"], "registry.tnlab-718ca9.testnet");
                assert_eq!(v["params"]["block_id"], "TEST_finalized");
                Ok(
                    json!({"result":{"block_height":123,"block_hash":if self.wrong_block{"other"}else{"TEST_finalized"},"result":serde_json::to_vec(&json!({"fund_id":"test-fund","account_id":"test-fund.sim.testnet","manager_id":"test-manager"})).unwrap()}}),
                )
            }
            _ => panic!("transaction method must never be used"),
        }
    }
}
#[test]
fn reads_pin_a_finalized_block_and_never_send_a_transaction() {
    let rpc = Mock {
        calls: RefCell::new(vec![]),
        wrong_block: false,
    };
    let views = NearViews::finalized(&rpc).unwrap();
    assert_eq!(
        views.fund("test-fund").unwrap()["manager_id"],
        "test-manager"
    );
    assert_eq!(rpc.calls.borrow().len(), 2);
    assert_eq!(views.view("pledge_loan", json!({})), Err("rpc_view_method"));
    assert_eq!(rpc.calls.borrow().len(), 2);
}
#[test]
fn conflicting_rpc_block_cannot_be_used_as_receipt_evidence() {
    let rpc = Mock {
        calls: RefCell::new(vec![]),
        wrong_block: true,
    };
    let views = NearViews::finalized(&rpc).unwrap();
    assert_eq!(views.fund("test-fund"), Err("registry_block_mismatch"));
}
