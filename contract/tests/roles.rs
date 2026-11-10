// Roles and pause (owner decision 6 Nov): ADMIN assigns roles and registers funds; REGISTRAR manages certificate
// and TEE signers; PAUSER pauses; SERVICER releases loans and submits TEE verdicts. Each role is refused every
// other role's job. Pause stops pledges, releases, certificate and verdict submissions; views and role changes
// keep working.
use near_sdk::test_utils::{accounts, VMContextBuilder};
use near_sdk::{testing_env, AccountId};
use truenav_registry::{Certificate, Registry};

#[path = "pledge_help.rs"]
mod pledge_help;

fn next_nonce() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(1);
    format!("{:064x}", N.fetch_add(1, Ordering::Relaxed))
}

fn pledge_as(r: &mut Registry, caller: &AccountId, fund: &AccountId, loan: &str, asset: &str) {
    let nonce = next_nonce();
    let when = 1_793_000_000_000u64;
    let exp = when + 60_000;
    ctx(caller);
    let sig = pledge_help::sign_pledge(&pledge_help::servicer_key(), "registry.test.near", fund.as_str(), loan, asset, &nonce, exp);
    r.pledge_loan(loan.into(), asset.into(), fund.clone(), nonce, exp, sig, None);
}

const LOAN: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const ADDR: &str = "0x00000000000000000000000000000000000000aa";

fn ctx(predecessor: &AccountId) {
    let mut b = VMContextBuilder::new();
    b.current_account_id("registry.test.near".parse().unwrap())
        .predecessor_account_id(predecessor.clone())
        .block_timestamp(1_793_000_000_000 * 1_000_000)
        .attached_deposit(near_sdk::NearToken::from_yoctonear(1));
    testing_env!(b.build());
}
fn admin() -> AccountId { accounts(0) }
fn registrar() -> AccountId { accounts(1) }
fn pauser() -> AccountId { accounts(2) }
fn servicer() -> AccountId { accounts(3) }
fn fund() -> AccountId { accounts(4) }

/// Four roles on four accounts, one registered fund that has pledged LOAN.
fn setup() -> Registry {
    ctx(&admin());
    let mut r = Registry::new(admin(), admin());
    r.set_role("registrar".into(), registrar());
    r.set_role("pauser".into(), pauser());
    r.set_role("servicer".into(), servicer());
    r.register_fund("f".into(), fund(), "m".into());
    r.set_servicer_pledge_key(pledge_help::address_of(&pledge_help::servicer_key()));
    pledge_as(&mut r, &fund(), &fund(), LOAN, "invoices");
    r
}
fn cert() -> Certificate {
    Certificate {
        fund_id: "f".into(), fund_account: fund(), manager_id: "m".into(), status: "scored".into(), score: Some(90), band: "green".into(),
        raw_x100: 9000, true_val_cents: near_sdk::json_types::U128(1), true_range_cents: near_sdk::json_types::U128(1),
        policy_nav_cents: near_sdk::json_types::U128(1), headline_cents: near_sdk::json_types::U128(1), blocked_attempts: 0,
        data_asof_ms: 1_793_000_000_000, signed_at_ms: 1_793_000_000_000, engine_commit: "x".into(),
    }
}

#[test]
fn roles_start_on_the_deployer_and_move_with_set_role() {
    ctx(&admin());
    let r0 = Registry::new(admin(), servicer());
    let g = r0.get_roles();
    assert_eq!((g.admin, g.registrar, g.pauser, g.servicer, g.paused), (admin(), admin(), admin(), servicer(), false));
    let r = setup();
    let g = r.get_roles();
    assert_eq!((g.registrar, g.pauser, g.servicer), (registrar(), pauser(), servicer()));
}

macro_rules! refused {
    ($name:ident, $who:expr, $msg:expr, |$r:ident| $call:expr) => {
        #[test]
        #[should_panic(expected = $msg)]
        fn $name() {
            let mut $r = setup();
            ctx(&$who);
            $call;
        }
    };
}

// The admin cannot do the registrar's, pauser's or servicer's job.
refused!(admin_cannot_add_signer, admin(), "registrar only", |r| r.add_signer(ADDR.into()));
refused!(admin_cannot_add_tee_signer, admin(), "registrar only", |r| r.add_tee_signer(ADDR.into(), "M".into(), "x".into(), "a".repeat(64)));
refused!(admin_cannot_pause, admin(), "pauser only", |r| r.pause());
refused!(admin_cannot_release, admin(), "servicer only", |r| r.release_loan(LOAN.into()));
// The registrar cannot do the admin's, pauser's or servicer's job.
refused!(registrar_cannot_register_fund, registrar(), "admin only", |r| r.register_fund("g".into(), accounts(5), "m".into()));
refused!(registrar_cannot_set_role, registrar(), "admin only", |r| r.set_role("pauser".into(), registrar()));
refused!(registrar_cannot_pause, registrar(), "pauser only", |r| r.pause());
refused!(registrar_cannot_release, registrar(), "servicer only", |r| r.release_loan(LOAN.into()));
// The pauser cannot do the admin's, registrar's or servicer's job.
refused!(pauser_cannot_register_fund, pauser(), "admin only", |r| r.register_fund("g".into(), accounts(5), "m".into()));
refused!(pauser_cannot_set_role, pauser(), "admin only", |r| r.set_role("servicer".into(), pauser()));
refused!(pauser_cannot_add_signer, pauser(), "registrar only", |r| r.add_signer(ADDR.into()));
refused!(pauser_cannot_release, pauser(), "servicer only", |r| r.release_loan(LOAN.into()));
// The servicer cannot do the admin's, registrar's or pauser's job.
refused!(servicer_cannot_register_fund, servicer(), "admin only", |r| r.register_fund("g".into(), accounts(5), "m".into()));
refused!(servicer_cannot_set_role, servicer(), "admin only", |r| r.set_role("admin".into(), servicer()));
refused!(servicer_cannot_add_tee_signer, servicer(), "registrar only", |r| r.add_tee_signer(ADDR.into(), "M".into(), "x".into(), "a".repeat(64)));
refused!(servicer_cannot_pause, servicer(), "pauser only", |r| r.pause());
// A registered fund holds no role.
refused!(fund_cannot_unpause, fund(), "pauser only", |r| r.unpause());

macro_rules! paused {
    ($name:ident, $who:expr, |$r:ident| $call:expr) => {
        #[test]
        #[should_panic(expected = "paused")]
        fn $name() {
            let mut $r = setup();
            ctx(&pauser());
            $r.pause();
            ctx(&$who);
            $call;
        }
    };
}

// Pause blocks every state-changing call of the flow.
paused!(pause_blocks_pledge, fund(), |r| r.pledge_loan("2".repeat(64), "invoices".into(), fund(), "aa".repeat(32), 1_793_000_000_000 + 60_000, "0x1234".into(), None));
paused!(pause_blocks_release, servicer(), |r| r.release_loan(LOAN.into()));
paused!(pause_blocks_certificates, admin(), |r| r.submit_certificate(cert(), format!("0x{}", "00".repeat(65))));
paused!(pause_blocks_verdicts, servicer(), |r| r.submit_verdict(LOAN.into(), "M".into(), "c".repeat(64), "{}".into(), format!("0x{}", "00".repeat(65))));

#[test]
fn pause_leaves_views_and_role_changes_working_and_unpause_restores() {
    let mut r = setup();
    ctx(&pauser());
    r.pause();
    assert!(r.get_roles().paused);
    // Views.
    assert!(r.get_fund("f".into()).is_some());
    assert_eq!(r.get_lock(LOAN.into()).unwrap().fund_id, "f");
    assert!(r.nft_token(LOAN.into()).is_some());
    assert_eq!(r.get_alert_count("f".into()), 0);
    assert_eq!(r.get_attempts_page("f".into(), 0, 10).count, 0);
    assert!(r.get_latest_verdict(LOAN.into()).is_none());
    assert_eq!(r.get_certificate_count("f".into()), 0);
    let _ = r.get_signers();
    let _ = r.get_tee_signers();
    // Role changes.
    ctx(&admin());
    r.set_role("servicer".into(), accounts(5));
    assert_eq!(r.get_roles().servicer, accounts(5));
    // Unpause restores the flow.
    ctx(&pauser());
    r.unpause();
    pledge_as(&mut r, &fund(), &fund(), &"3".repeat(64), "invoices");
}

#[test]
#[should_panic(expected = "role must be admin, registrar, pauser or servicer")]
fn unknown_role_is_refused() {
    let mut r = setup();
    ctx(&admin());
    r.set_role("owner".into(), accounts(5));
}
