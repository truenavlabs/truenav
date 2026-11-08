// Paid query contract unit tests (near-sdk mocked chain).
use near_sdk::json_types::U128;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, AccountId, NearToken};
use truenav_query::{Query, DAY_NS};

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
const FEE: NearToken = NearToken::from_millinear(10);
const H1: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const H2: &str = "2222222222222222222222222222222222222222222222222222222222222222";

fn set(who: &str, deposit: NearToken, now_ns: u64, balance: NearToken) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("query.truenav.testnet")).predecessor_account_id(acc(who)).signer_account_id(acc(who)).attached_deposit(deposit).block_timestamp(now_ns).account_balance(balance).storage_usage(1_000);
    testing_env!(b.build());
}
fn at(who: &str, deposit: NearToken, now_ns: u64) {
    set(who, deposit, now_ns, NearToken::from_near(5));
}
fn setup() -> Query {
    at("admin.testnet", NearToken::from_yoctonear(0), 1_000);
    Query::new(acc("admin.testnet"), acc("api.truenav.testnet"), U128(FEE.as_yoctonear()))
}
fn panics(f: impl FnOnce()) -> String {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(_) => String::new(),
        Err(e) => e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default(),
    }
}

#[test]
fn exact_fee_buys_a_one_use_report_entitlement_valid_24_hours() {
    let mut q = setup();
    at("agent.testnet", FEE, 1_000);
    let e = q.buy_query("req-0001-report".into(), H1.into(), "report".into());
    assert_eq!((e.uses_left, e.expires_ns.0, e.buyer.as_str()), (1, 1_000 + DAY_NS, "agent.testnet"));
    assert!(get_logs().iter().any(|l| l.contains("query_bought")));
    at("api.truenav.testnet", NearToken::from_yoctonear(0), 2_000);
    assert_eq!(q.redeem("req-0001-report".into(), H1.into()), 0);
    assert!(panics(|| { let _ = q.redeem("req-0001-report".into(), H1.into()); }).contains("already used"));
}

#[test]
fn any_other_amount_is_refused_before_anything_is_stored() {
    let mut q = setup();
    for wrong in [NearToken::from_yoctonear(0), NearToken::from_millinear(9), NearToken::from_millinear(11), NearToken::from_near(1)] {
        at("agent.testnet", wrong, 1_000);
        assert!(panics(|| drop(q.buy_query("req-0002-wrong".into(), H1.into(), "report".into()))).contains("attach exactly"));
    }
    assert!(q.get_entitlement("req-0002-wrong".into()).is_none());
    assert_eq!(q.get_config()["sold"], 0);
}

#[test]
fn an_ask_entitlement_allows_20_questions() {
    let mut q = setup();
    at("agent.testnet", FEE, 1_000);
    q.buy_query("req-0003-ask".into(), H2.into(), "ask".into());
    at("api.truenav.testnet", NearToken::from_yoctonear(0), 2_000);
    for left in (0..20).rev() {
        assert_eq!(q.redeem("req-0003-ask".into(), H2.into()), left);
    }
    assert!(panics(|| { let _ = q.redeem("req-0003-ask".into(), H2.into()); }).contains("already used"));
}

#[test]
fn redeem_checks_the_redeemer_the_bound_query_and_expiry() {
    let mut q = setup();
    at("agent.testnet", FEE, 1_000);
    q.buy_query("req-0004-bound".into(), H1.into(), "report".into());
    at("agent.testnet", NearToken::from_yoctonear(0), 2_000);
    assert!(panics(|| { let _ = q.redeem("req-0004-bound".into(), H1.into()); }).contains("redeemer only"));
    at("api.truenav.testnet", NearToken::from_yoctonear(0), 2_000);
    assert!(panics(|| { let _ = q.redeem("req-0004-bound".into(), H2.into()); }).contains("another query"));
    assert!(panics(|| { let _ = q.redeem("req-0004-missing".into(), H1.into()); }).contains("unknown entitlement"));
    at("api.truenav.testnet", NearToken::from_yoctonear(0), 1_000 + DAY_NS);
    assert!(panics(|| { let _ = q.redeem("req-0004-bound".into(), H1.into()); }).contains("expired"));
    assert_eq!(q.get_entitlement("req-0004-bound".into()).unwrap().uses_left, 1, "a refused redeem spends nothing");
}

#[test]
fn bad_input_and_reuse_are_refused() {
    let mut q = setup();
    at("agent.testnet", FEE, 1_000);
    assert!(panics(|| drop(q.buy_query("short".into(), H1.into(), "report".into()))).contains("request_id"));
    assert!(panics(|| drop(q.buy_query("req-0005-x".into(), "ABC".into(), "report".into()))).contains("query_hash"));
    assert!(panics(|| drop(q.buy_query("req-0005-x".into(), H1.into(), "score".into()))).contains("kind must be"));
    q.buy_query("req-0005-x".into(), H1.into(), "report".into());
    at("other.testnet", FEE, 1_100);
    assert!(panics(|| drop(q.buy_query("req-0005-x".into(), H2.into(), "report".into()))).contains("already used"));
    assert_eq!(q.get_entitlement("req-0005-x".into()).unwrap().buyer.as_str(), "agent.testnet");
}

#[test]
fn withdraw_is_admin_only_bounded_and_emits_an_event() {
    let mut q = setup();
    at("someone.testnet", NearToken::from_yoctonear(0), 1_000);
    assert!(panics(|| drop(q.withdraw(U128(1), acc("someone.testnet")))).contains("admin only"));
    set("admin.testnet", NearToken::from_yoctonear(1), 1_000, NearToken::from_near(1));
    assert!(panics(|| drop(q.withdraw(U128(NearToken::from_near(1).as_yoctonear()), acc("admin.testnet")))).contains("can be withdrawn"));
    let _ = q.withdraw(U128(NearToken::from_millinear(100).as_yoctonear()), acc("admin.testnet"));
    assert!(get_logs().iter().any(|l| l.contains("\"event\":\"withdraw\"")));
}

#[test]
fn pause_fee_and_redeemer_changes_are_admin_only() {
    let mut q = setup();
    at("agent.testnet", NearToken::from_yoctonear(0), 1_000);
    assert!(panics(|| q.set_paused(true)).contains("admin only"));
    assert!(panics(|| q.set_fee(U128(1))).contains("admin only"));
    assert!(panics(|| q.set_redeemer(acc("agent.testnet"))).contains("admin only"));
    at("admin.testnet", NearToken::from_yoctonear(1), 1_000);
    q.set_paused(true);
    at("agent.testnet", FEE, 1_000);
    assert!(panics(|| drop(q.buy_query("req-0006-paused".into(), H1.into(), "report".into()))).contains("paused"));
}

#[test]
fn admin_calls_need_exactly_one_yocto_and_redeem_needs_none() {
    let mut q = setup();
    at("admin.testnet", NearToken::from_yoctonear(0), 1_000);
    assert!(panics(|| q.set_paused(true)).contains("1 yoctoNEAR"));
    at("agent.testnet", FEE, 1_000);
    q.buy_query("req-0007-key".into(), H1.into(), "report".into());
    at("api.truenav.testnet", NearToken::from_yoctonear(0), 2_000);
    assert_eq!(q.redeem("req-0007-key".into(), H1.into()), 0);
}
