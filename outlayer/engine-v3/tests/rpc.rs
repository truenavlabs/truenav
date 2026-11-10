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
fn a_signed_double_pledge_attempt_is_read_from_get_attempts_page() {
    struct Pages {
        calls: RefCell<Vec<String>>,
    }
    impl Transport for Pages {
        fn post_json(&self, v: &Value) -> Result<Value> {
            if v["method"] == "block" {
                return Ok(json!({"result":{"header":{"height":9,"hash":"BLOCK"}}}));
            }
            let method = v["params"]["method_name"].as_str().unwrap_or("");
            self.calls.borrow_mut().push(method.to_string());
            let body = match method {
                "get_fund" => json!({"fund_id":"meridian-yield-fund","account_id":"meridian.testnet","manager_id":"manager-meridian"}),
                "get_attempts_page" => json!({"count":1,"attempts":[{"attempt_id":"attempt-1","at_ms":1_700_000_000_000u64}]}),
                "get_certificate_count" => json!(0),
                "get_certificate_history_page" => json!([]),
                "get_lock" => Value::Null,
                _ => return Err("rpc_view_method"),
            };
            Ok(json!({"result":{"block_height":9,"block_hash":"BLOCK","result":serde_json::to_vec(&body).unwrap()}}))
        }
    }
    let rpc = Pages { calls: RefCell::new(vec![]) };
    let views = NearViews::finalized(&rpc).unwrap();
    let scope = truenav_v3_core::source::Scope {
        network: "testnet".into(),
        receipts_contract: "receipts.testnet".into(),
        fund_account: "meridian.testnet".into(),
        token_id: "meridian-yield-fund".into(),
        fund_id: "meridian-yield-fund".into(),
    };
    let snap = views.snapshot(&scope, &[], "2026-11-10T00:00:00Z").unwrap();
    assert!(rpc.calls.borrow().iter().any(|m| m == "get_attempts_page"));
    assert_eq!(snap.attempts.as_array().unwrap().len(), 1);
    assert_eq!(snap.attempts[0]["action_id"], "attempt-1");
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
