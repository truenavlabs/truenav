//! TEST ONLY runtime-generated signing material, minimal financial inputs for backend tests.
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use truenav_engine_v3::{engine::*, nav};
use truenav_v3_core::source::*;
use truenav_v3_core::{canonical, hash, validate};
struct TestMac;
impl Fingerprinter for TestMac {
    fn mac(&self, m: &[u8]) -> truenav_v3_core::Result<[u8; 32]> {
        use hmac::{Hmac, Mac};
        use sha2::Sha256;
        let mut h =
            Hmac::<Sha256>::new_from_slice(b"TrueNav TEST ONLY fingerprint key v1").unwrap();
        h.update(m);
        Ok(h.finalize().into_bytes().into())
    }
}
#[derive(Clone)]
struct Read {
    snapshot: Snapshot,
}
impl RegistryReader for Read {
    fn read(&self, scope: &Scope, fp: &[String], _: &str) -> truenav_v3_core::Result<Snapshot> {
        if scope.network != "near_testnet"
            || self.snapshot.locks.len() != fp.len()
            || self
                .snapshot
                .locks
                .iter()
                .any(|r| !fp.contains(&r.fingerprint))
        {
            return Err("registry_snapshot_invalid");
        }
        Ok(self.snapshot.clone())
    }
}
fn test_key(role: &str) -> SigningKey {
    // Public fixture seed only, matching the simulated-data fixture registry. Never used by the live host.
    let id = match role {
        "servicer" => "servicer:simcredit:v1",
        "bank" => "bank:simcash:v1",
        "fund_admin" => "fund_admin:simadmin:v1",
        "custodian" => "custodian:simcustody:v1",
        _ => panic!("TEST role"),
    };
    let mut framed = Vec::new();
    for x in ["truenav-sim-key-v1", "truenav-full-model-v3", id] {
        lp(&mut framed, x.as_bytes()).unwrap();
    }
    SigningKey::from_bytes(&sha2_bytes(&framed))
}
fn sign(s: &mut SignedSource) {
    s.payload_sha256 = hash(canonical(&s.payload).unwrap().as_bytes());
    s.signature = hex::encode(
        test_key(&s.source)
            .sign(&sha2_bytes(&source_preimage(s).unwrap()))
            .to_bytes(),
    );
}
fn setup(index: usize) -> (Context, Vec<SignedSource>, Policy, Read) {
    let f: Value = serde_json::from_str(include_str!("../../../spec/nav/fixtures.json")).unwrap();
    let mut fund = f["funds"][index].clone();
    let token = fund["fund_id"].as_str().unwrap().to_string();
    let short = if index == 0 { "harbor" } else { "meridian" };
    let engine_hash = std::env::var("TRUENAV_TEST_ENGINE_SHA256")
        .unwrap_or_else(|_| hash(b"TEST ONLY no WASI build provided"));
    let c = Context {
        scope: Scope {
            network: "near_testnet".into(),
            receipts_contract: "receipts.tnlab-718ca9.testnet".into(),
            fund_account: format!("{short}.sim.testnet"),
            token_id: token.clone(),
            fund_id: token.clone(),
        },
        period: Period {
            period_start: "2026-10-01".into(),
            period_end: "2026-11-01".into(),
        },
        seq: "1".into(),
        prev_receipt_sha256: None,
        supersedes_seq: None,
        correction_reason_code: None,
        request_id: format!("TEST_{short}"),
        request_nonce: hash(format!("TrueNav TEST ONLY nonce:{short}").as_bytes()),
        engine_version_key: engine_hash.clone(),
        engine_code_sha256: engine_hash,
        valuation_time: f["valuation_time"].as_str().unwrap().into(),
        issued_at: "2026-11-10T12:01:00Z".into(),
    };
    let registry: Registry = serde_json::from_str(include_str!(
        "../../../engine/v3-core/tests/fixtures/source-registry.TEST.json"
    ))
    .unwrap();
    let policy = Policy {
        source_registry: registry,
        minimum_revisions: ["servicer", "bank", "fund_admin", "custodian"]
            .map(|r| (r.to_string(), 1))
            .into_iter()
            .collect(),
        case_sensitive_namespaces: vec![],
        previous_cash_passport: vec![],
        previous_period: None,
    };
    let history = fund["certificate"]["history"].clone();
    let blocked = fund["blocked_attempts"].clone();
    let mut loans = fund["loans"].as_array().unwrap().clone();
    let mut terms = Vec::new();
    let mut locks = Vec::new();
    let mut roster = Vec::new();
    let mut schedule = Vec::new();
    let mut payments = Vec::new();
    let mut transactions = Vec::new();
    for (i, l) in loans.iter_mut().enumerate() {
        let id = l["id"].as_str().unwrap().to_string();
        let t = LoanTerms {
            version: "loan-terms-v2".into(),
            borrower_namespace: "demo".into(),
            borrower_id: format!("BORROWER {short} {i}").to_uppercase(),
            origination_date: "2026-01-01".into(),
            principal_cents: ((l["principal"].as_f64().unwrap() * 100.0).round() as i128)
                .to_string(),
            currency: "USD".into(),
            collateral_namespace: "demo".into(),
            collateral_ref: format!("COLLATERAL {short} {i}").to_uppercase(),
        };
        let tv = canonical_terms(&t, &[]).unwrap();
        l["terms"] = tv.clone();
        l["lien_rank"] = json!(1);
        terms.push(json!({"loan_id":id,"terms":tv,"lien_rank":1}));
        locks.push(LockRead {
            fingerprint: fingerprint(&t, l["asset"].as_str().unwrap(), &[], &TestMac).unwrap(),
            completed: true,
            owner: Some(c.scope.fund_account.clone()),
            fund_token_id: Some(c.scope.token_id.clone()),
        });
        let open = l["principal"].as_f64().unwrap() + l["accrued"].as_f64().unwrap()
            - l["repaid"].as_f64().unwrap()
            != 0.0;
        if !open {
            continue;
        }
        // One-cent, fully settled dues isolate cash cap tests from the legacy NAV pin.
        roster.push(json!({"loan_id":id,"borrower_payer":format!("TEST payer {i}"),"principal_cents":1,"dpd":0}));
        schedule.push(
            json!({"loan_id":id,"due_date":"2026-10-15","amount_cents":1,"component":"interest"}),
        );
        payments.push(json!({"payment_id":format!("p-{i}"),"loan_id":id,"payer":format!("TEST payer {i}"),"amount_cents":1,"paid_date":"2026-10-15","reference":format!("pay-{i}"),"component":"interest"}));
        transactions.push(json!({"transaction_id":format!("b-{i}"),"date":"2026-10-15","amount_cents":-1,"counterparty":format!("TEST payer {i}"),"reference":format!("pay-{i}"),"category":"LOAN_PAYMENT"}));
    }
    fund.as_object_mut().unwrap().remove("loans");
    fund.as_object_mut().unwrap().remove("blocked_attempts");
    let servicer = json!({"loans":loans,"cashflow":{"as_of":c.valuation_time,"loans":roster,"schedule":schedule,"payments":payments}});
    let bank = json!({"as_of":c.valuation_time,"synthetic":true,"transactions":transactions});
    let admin = json!({"fund":fund,"issuer":{"as_of":c.valuation_time,"reported_yield_bps":0,"principal_outstanding_cents":1000000000,"distributions_paid_cents":0}});
    let custodian = json!({"loan_terms":terms});
    let mut sources = Vec::new();
    for (role, payload) in [
        ("servicer", servicer),
        ("bank", bank),
        ("fund_admin", admin),
        ("custodian", custodian),
    ] {
        let mut s = SignedSource {
            source: role.into(),
            key_id: policy
                .source_registry
                .keys
                .iter()
                .find(|k| k.role == role)
                .unwrap()
                .key_id
                .clone(),
            scope: c.scope.clone(),
            period: c.period.clone(),
            revision: "1".into(),
            data_as_of: c.valuation_time.clone(),
            payload,
            payload_sha256: String::new(),
            signature: String::new(),
        };
        sign(&mut s);
        sources.push(s);
    }
    let at = truenav_v3_core::timestamp(&c.valuation_time).unwrap();
    let events: Vec<_> = blocked
        .as_array()
        .unwrap()
        .iter()
        .map(|b| {
            let age = b["age_days"].as_f64().unwrap();
            let t = at - (age * 86_400_000.0) as i64;
            json!({"action_id":b["action_id"],"at":truenav_engine_v2::tee::iso_from_unix(t/1000)})
        })
        .collect();
    let read = Read {
        snapshot: Snapshot {
            registry_account: "registry.tnlab-718ca9.testnet".into(),
            block_height: "123456".into(),
            block_hash: "TEST_ONLY_finalized_block".into(),
            finalized: true,
            manager_id: format!("mgr-{short}.demo"),
            locks,
            attempts: json!(events),
            certificate_history: history,
            manager_funds: vec![],
            manager_attempt_log: json!({}),
        },
    };
    (c, sources, policy, read)
}
fn salt() -> [u8; 32] {
    sha2_bytes(b"TrueNav TEST ONLY salt v1")
}
#[test]
fn private_report_pins_and_public_pins() {
    for (i, score, private, band) in [(0, 99, 9917, "green"), (1, 43, 4284, "red")] {
        let (c, s, p, r) = setup(i);
        let out = evaluate(&c, &s, &p, &r, &TestMac, &salt()).unwrap();
        assert_eq!(out.envelope["score"], score, "{i}");
        assert_eq!(out.private_report["score_x100"], private, "{i}");
        assert_eq!(out.envelope["band"], band, "{i}");
        validate(&out.envelope).unwrap();
    }
}
#[test]
fn ladder_boundaries_and_ties() {
    for (x, y) in [
        (999000000, 999000000),
        (1000000000, 1000000000),
        (1001000000, 1002000000),
        (1235000000, 1236000000),
        (2000000000, 2000000000),
        (5000000000, 5000000000),
        (12300000000, 12300000000),
        (100500000, 101000000),
        (-100500000, -101000000),
    ] {
        assert_eq!(round_nav(x).unwrap(), y)
    }
    assert!(round_nav(i128::MIN).is_err());
}
#[test]
fn count_and_coverage_do_not_pin_small_positive_counts() {
    let mut pairs: BTreeMap<(String, u64), BTreeMap<usize, ()>> = BTreeMap::new();
    for total in 1..=10000 {
        for completed in 0..=total.min(10) {
            pairs
                .entry((
                    count_band(completed).into(),
                    coverage_bps(completed, total).unwrap(),
                ))
                .or_default()
                .insert(completed, ());
        }
    }
    for ((band, bps), counts) in pairs {
        if band == "lt_5" {
            assert!(counts.len() >= 2, "{band}/{bps}")
        }
    }
}
#[test]
fn invalid_signatures_close_the_receipt_before_private_values_are_used() {
    for code in ["forged", "unknown"] {
        let (c, mut s, p, r) = setup(0);
        if code == "forged" {
            s[0].payload = json!("malformed private input")
        } else {
            s[0].key_id = "servicer:private_loan_input:v1".into()
        }
        if code == "unknown" {
            assert!(matches!(
                evaluate(&c, &s, &p, &r, &TestMac, &salt()),
                Err("source_key_unknown")
            ));
            continue;
        }
        let out = evaluate(&c, &s, &p, &r, &TestMac, &salt()).unwrap();
        assert_eq!(out.envelope["status"], "verification_failed");
        assert!(out.envelope["score"].is_null());
        assert!(out.envelope["reported_nav"].is_null());
        assert!(out.private_report["rejected"] == true);
    }
}
#[test]
fn second_liens_are_unverified_and_unknown_and_missing_reads_reduce_coverage() {
    let (c, mut s, p, mut r) = setup(0);
    s[0].payload["loans"][0]["lien_rank"] = json!(2);
    s[3].payload["loan_terms"][0]["lien_rank"] = json!(2);
    sign(&mut s[0]);
    sign(&mut s[3]);
    let out = evaluate(&c, &s, &p, &r, &TestMac, &salt()).unwrap();
    assert_eq!(out.envelope["pledge_result"], "unknown");
    assert!(out.envelope["holds"]
        .as_array()
        .unwrap()
        .contains(&json!("second_lien_unsupported")));
    r.snapshot.locks[0].completed = false;
    let partial = evaluate(&c, &s, &p, &r, &TestMac, &salt()).unwrap();
    assert!(partial.envelope["pledge_coverage_bps"].as_u64().unwrap() < 10000);
}
#[test]
fn cashflow_caps_replace_no_legacy_weight() {
    let (c, mut s, p, r) = setup(0);
    s[2].payload["issuer"]["reported_yield_bps"] = json!(10000);
    sign(&mut s[2]);
    let out = evaluate(&c, &s, &p, &r, &TestMac, &salt()).unwrap();
    assert_eq!(out.envelope["score"], 59);
    assert_eq!(out.envelope["band"], "red");
    assert_eq!(out.private_report["parts_x100"]["gap"], 4000);
    assert_eq!(out.private_report["parts_x100"]["coverage"], 4000);
}
#[test]
fn commitments_bind_exact_values_and_salt_never_public() {
    let (c, s, p, r) = setup(0);
    let a = evaluate(&c, &s, &p, &r, &TestMac, &salt()).unwrap();
    let b = evaluate(&c, &s, &p, &r, &TestMac, &[7; 32]).unwrap();
    assert_ne!(a.envelope["commitments"], b.envelope["commitments"]);
    let private_bytes = canonical(&a.private_report).unwrap();
    let decoded = truenav_v3_core::parse(private_bytes.as_bytes()).unwrap();
    assert_eq!(private_bytes, canonical(&decoded).unwrap());
    let public = canonical(&a.envelope).unwrap();
    assert!(!public.contains(&hex::encode(salt())));
    for k in [
        "score_x100",
        "parts_x100",
        "raw_score",
        "salt_hex",
        "principal_cents",
        "claimed_not_settled_cents",
    ] {
        assert!(a.envelope.get(k).is_none())
    }
    assert!(a.private_report["raw_score"].is_string());
    assert_eq!(
        a.private_report["private_registry_state_root"],
        hash(
            canonical(&a.private_report["registry_read_manifest"])
                .unwrap()
                .as_bytes()
        )
    );
    let nonce = hex::decode(&c.request_nonce).unwrap().try_into().unwrap();
    for key in ["reported_nav", "trueval", "truerange_low", "truerange_high"] {
        let value = json!({"currency":"USD","cents":a.private_report["exact"][key]});
        assert_eq!(
            a.envelope["commitments"][key],
            commitment(&format!("nav_exact:{key}"), &value, &nonce, &salt()).unwrap()
        );
    }
    assert_eq!(
        a.envelope["commitments"]["full_report"],
        commitment("full_report", &a.private_report, &nonce, &salt()).unwrap()
    );
}
#[test]
fn legacy_nav_port_matches_benchmark_values() {
    let f: Value = serde_json::from_str(include_str!("../../../spec/nav/fixtures.json")).unwrap();
    let at = truenav_v3_core::timestamp(f["valuation_time"].as_str().unwrap()).unwrap();
    for (i, pin) in [(0, 9917), (1, 4284)] {
        let fund = &f["funds"][i];
        let n = nav::score(fund, at, &fund["certificate"]["history"]);
        assert_eq!(nav::half_up(n.raw * 100.0), pin)
    }
}
#[test]
fn engine_derived_vectors() {
    let path = "../../schema/vectors/engine-v3-derived.json";
    let mut vectors = Vec::new();
    for i in 0..2 {
        let (c, s, p, r) = setup(i);
        let out = evaluate(&c, &s, &p, &r, &TestMac, &salt()).unwrap();
        vectors.push(json!({"name":if i==0{"harbor"}else{"meridian"},"envelope":out.envelope,"private_TEST_report":out.private_report}));
    }
    let (mut c, s, p, r) = setup(0);
    c.seq = "2".into();
    c.prev_receipt_sha256 = vectors[0]["envelope"]["receipt_sha256"]
        .as_str()
        .map(str::to_string);
    c.supersedes_seq = Some("1".into());
    c.correction_reason_code = Some("source_correction".into());
    c.request_id = "TEST_correction".into();
    c.request_nonce = hash(b"TrueNav TEST ONLY correction nonce");
    let out = evaluate(&c, &s, &p, &r, &TestMac, &salt()).unwrap();
    vectors.push(json!({"name":"harbor_correction","envelope":out.envelope,"private_TEST_report":out.private_report}));
    let (c, mut s, p, r) = setup(0);
    s[2].payload["issuer"]["reported_yield_bps"] = json!(10000);
    sign(&mut s[2]);
    let out = evaluate(&c, &s, &p, &r, &TestMac, &salt()).unwrap();
    vectors.push(json!({"name":"harbor_capped","envelope":out.envelope,"private_TEST_report":out.private_report}));
    let (c, sources, p, mut r) = temporal_setup();
    r.snapshot.locks[5].owner = Some("other.sim.testnet".into());
    r.snapshot.locks[5].fund_token_id = Some("other-simulated-fund".into());
    let conflict = evaluate(&c, &sources, &p, &r, &TestMac, &salt()).unwrap();
    let private = &conflict.private_report;
    let case = json!({"name":"active_first_lien_conflict","envelope":conflict.envelope,"private_TEST_report":{"score_x100":private["score_x100"],"parts_x100":private["parts_x100"],"raw_score":private["raw_score"],"exact":private["exact"]}});
    let v = json!({"classification":"TEST ONLY runtime-derived synthetic evidence, public TEST salts, no live attestation","source_registry":"engine/v3-core/tests/fixtures/source-registry.TEST.json","vectors":vectors,"temporal_cases":[temporal_case()],"conflict_cases":[case]});
    if std::env::var_os("TRUENAV_WRITE_DERIVED_VECTORS").is_some() {
        assert!(
            std::env::var_os("TRUENAV_TEST_ENGINE_SHA256").is_some(),
            "must use real built WASI hash"
        );
        std::fs::write(path, serde_json::to_string_pretty(&v).unwrap() + "\n").unwrap();
    } else if std::path::Path::new(path).exists()
        && std::env::var_os("TRUENAV_TEST_ENGINE_SHA256").is_some()
    {
        let want: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert!(v == want, "engine-derived artifact drift");
    }
}

#[test]
fn demo_credit_reconstruction_inputs_are_absent_from_the_real_v3_projection() {
    let (c0, _, mut p, _) = setup(0);
    let mut c = c0.clone();
    c.scope.token_id = "DEMO-CREDIT".into();
    c.scope.fund_id = c.scope.token_id.clone();
    c.scope.fund_account = "demo.sim.testnet".into();
    c.valuation_time = "2026-11-08T09:00:00Z".into();
    c.issued_at = c.valuation_time.clone();
    for k in &mut p.source_registry.keys {
        k.fund_scope.push(c.scope.token_id.clone())
    }
    let fx: Value = serde_json::from_str(include_str!(
        "../../../cashflow/fixtures/parity/cashflow-parity-DEMO-CREDIT.json"
    ))
    .unwrap();
    let ds = &fx["input"]["dataset"];
    let mut loans = Vec::new();
    let mut terms = Vec::new();
    let mut locks = Vec::new();
    for (i, l) in ds["servicer_tape"]["loans"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        let id = l["loan_id"].as_str().unwrap();
        let t = LoanTerms {
            version: "loan-terms-v2".into(),
            borrower_namespace: "demo".into(),
            borrower_id: format!("DEMO TEST {i}"),
            origination_date: "2026-01-01".into(),
            principal_cents: l["principal_cents"].to_string(),
            currency: "USD".into(),
            collateral_namespace: "demo".into(),
            collateral_ref: format!("DEMO TEST {i}"),
        };
        let tv = canonical_terms(&t, &[]).unwrap();
        loans.push(json!({"id":id,"principal":500000,"accrued":0,"repaid":0,"asset":"invoices","bucket":if i<3{"dpd_61_90"}else{"current"},"servicer_asof":"2026-11-08T06:00:00Z","terms":tv,"lien_rank":1}));
        terms.push(json!({"loan_id":id,"terms":tv,"lien_rank":1}));
        locks.push(LockRead {
            fingerprint: fingerprint(&t, "invoices", &[], &TestMac).unwrap(),
            completed: true,
            owner: Some(c.scope.fund_account.clone()),
            fund_token_id: Some(c.scope.token_id.clone()),
        });
    }
    let fund = json!({"fund_id":c.scope.token_id,"headline_nav":10000000,"cash":0,"liabilities":0,"nav_report_date":"2026-11-08T06:00:00Z","certificate":{"data_asof":"2026-11-08T06:00:00Z","signer":"demo.manager"}});
    let mut sources = Vec::new();
    for (role, payload) in [
        (
            "servicer",
            json!({"loans":loans,"cashflow":ds["servicer_tape"]}),
        ),
        ("bank", ds["bank_feed"].clone()),
        ("fund_admin", json!({"fund":fund,"issuer":ds["issuer"]})),
        ("custodian", json!({"loan_terms":terms})),
    ] {
        let mut s = SignedSource {
            source: role.into(),
            key_id: p
                .source_registry
                .keys
                .iter()
                .find(|k| k.role == role)
                .unwrap()
                .key_id
                .clone(),
            scope: c.scope.clone(),
            period: c.period.clone(),
            revision: "1".into(),
            data_as_of: if role == "bank" {
                "2026-11-08T08:30:00Z".into()
            } else {
                "2026-11-08T06:00:00Z".into()
            },
            payload,
            payload_sha256: String::new(),
            signature: String::new(),
        };
        sign(&mut s);
        sources.push(s);
    }
    let r = Read {
        snapshot: Snapshot {
            registry_account: "registry.tnlab-718ca9.testnet".into(),
            block_height: "123".into(),
            block_hash: "TEST_ONLY_finalized".into(),
            finalized: true,
            manager_id: "demo.manager".into(),
            locks,
            attempts: json!([]),
            certificate_history: json!([]),
            manager_funds: vec![],
            manager_attempt_log: json!({}),
        },
    };
    let out = evaluate(&c, &sources, &p, &r, &TestMac, &salt()).unwrap();
    let public = canonical(&out.envelope).unwrap();
    for forbidden in [
        "principal_cents",
        "late_share_bps",
        "850000000",
        "claimed_not_settled_cents",
        "cash_received_cents",
    ] {
        assert!(!public.contains(forbidden))
    }
    assert_eq!(out.envelope["late_share_band"], "gt_10_lte_25pct");
    assert_eq!(out.envelope["late_loan_cohorts"]["dpd_61_90"], "lt_5");
    assert!(out.envelope["late_loan_cohorts"]
        .as_object()
        .unwrap()
        .values()
        .all(|v| v == "lt_5" || v == "suppressed"));
}

// A narrowly scoped 100-position fixture is needed to exercise the accepted temporal disclosure window.
fn temporal_setup() -> (Context, Vec<SignedSource>, Policy, Read) {
    let (c, mut sources, p, mut r) = setup(0);
    let mut loans = Vec::new();
    let mut terms = Vec::new();
    let mut locks = Vec::new();
    let mut roster = Vec::new();
    let mut dues = Vec::new();
    let mut payments = Vec::new();
    let mut txs = Vec::new();
    for i in 0..100 {
        let id = format!("TEST-temporal-{i}");
        let t = LoanTerms {
            version: "loan-terms-v2".into(),
            borrower_namespace: "demo".into(),
            borrower_id: format!("TEST TEMPORAL {i}"),
            origination_date: "2026-01-01".into(),
            principal_cents: "10000000".into(),
            currency: "USD".into(),
            collateral_namespace: "demo".into(),
            collateral_ref: format!("TEST TEMPORAL {i}"),
        };
        let tv = canonical_terms(&t, &[]).unwrap();
        loans.push(json!({"id":id,"principal":100000,"accrued":0,"repaid":0,"asset":"real_estate","bucket":"current","servicer_asof":"2026-11-09T06:00:00Z","origination_date":"2026-01-01","terms":tv,"lien_rank":1}));
        terms.push(json!({"loan_id":id,"terms":tv,"lien_rank":1}));
        locks.push(LockRead {
            fingerprint: fingerprint(&t, "real_estate", &[], &TestMac).unwrap(),
            completed: true,
            owner: if i < 5 {
                None
            } else {
                Some(c.scope.fund_account.clone())
            },
            fund_token_id: if i < 5 {
                None
            } else {
                Some(c.scope.token_id.clone())
            },
        });
        roster.push(
            json!({"loan_id":id,"borrower_payer":format!("TEST TEMPORAL {i}"),"principal_cents":1}),
        );
        dues.push(
            json!({"loan_id":id,"due_date":"2026-10-15","amount_cents":1,"component":"interest"}),
        );
        payments.push(json!({"payment_id":format!("p-{i}"),"loan_id":id,"paid_date":"2026-10-15","amount_cents":1}));
        txs.push(json!({"transaction_id":format!("b-{i}"),"date":"2026-10-15","amount_cents":-1,"counterparty":format!("TEST TEMPORAL {i}"),"category":"LOAN_PAYMENT"}));
    }
    sources[0].payload = json!({"loans":loans,"cashflow":{"as_of":c.valuation_time,"loans":roster,"schedule":dues,"payments":payments}});
    sources[1].payload["transactions"] = json!(txs);
    sources[2].payload["fund"]["headline_nav"] = json!(9400000);
    sources[2].payload["fund"]["policy_markdown"] = json!({});
    sources[3].payload["loan_terms"] = json!(terms);
    for s in &mut sources {
        sign(s)
    }
    r.snapshot.locks = locks;
    (c, sources, p, r)
}
fn temporal_case() -> Value {
    let (c, sources, p, mut r) = temporal_setup();
    let before = evaluate(&c, &sources, &p, &r, &TestMac, &salt()).unwrap();
    r.snapshot.locks[5].owner = None;
    r.snapshot.locks[5].fund_token_id = None;
    let mut after_context = c.clone();
    after_context.seq = "2".into();
    after_context.prev_receipt_sha256 = before.envelope["receipt_sha256"]
        .as_str()
        .map(str::to_string);
    after_context.supersedes_seq = Some("1".into());
    after_context.correction_reason_code = Some("coverage_correction".into());
    after_context.request_nonce = hash(b"TrueNav TEST ONLY temporal after nonce");
    let after = evaluate(&after_context, &sources, &p, &r, &TestMac, &salt()).unwrap();
    assert_eq!(before.envelope["score"], 97);
    assert_eq!(after.envelope["score"], 97);
    assert_eq!(before.envelope["nav_result"], "inside");
    assert_eq!(after.envelope["nav_result"], "inside");
    json!({"name":"loan_turns_unverified","before":before.envelope,"after":after.envelope,"known_side_information":{"coverage_loss_points":"0.4","money_values_unchanged":false}})
}
#[test]
fn consecutive_engine_receipts_cover_a_loan_turning_unverified() {
    let c = temporal_case();
    assert_ne!(c["before"]["receipt_sha256"], c["after"]["receipt_sha256"]);
}

#[test]
fn a_shared_wallet_does_not_make_another_funds_lock_ours() {
    let (c, s, p, mut r) = setup(0);
    r.snapshot.locks[0].fund_token_id = Some("another-simulated-fund".into());
    let out = evaluate(&c, &s, &p, &r, &TestMac, &salt()).unwrap();
    assert_eq!(out.envelope["pledge_result"], "conflict");
    assert!(
        out.private_report["parts_x100"]["coverage"]
            .as_u64()
            .unwrap()
            < 4000
    );
}
#[test]
fn issuer_cannot_attest_cash_without_a_matching_signed_bank_balance() {
    let (c, mut s, p, r) = setup(0);
    s[2].payload["fund"]["cash"] = json!(1000000);
    s[2].payload["fund"]["cash_attested"] = json!(true);
    s[2].payload["fund"]["cash_asof"] = json!(c.valuation_time);
    sign(&mut s[2]);
    assert!(matches!(
        evaluate(&c, &s, &p, &r, &TestMac, &salt()),
        Err("cash_attestation_unbound")
    ));
}

#[test]
fn fingerprint_and_report_keys_are_common_to_the_receipts_predecessor() {
    let m: Value = serde_json::from_str(include_str!("../manifest.json")).unwrap();
    let keys = m["encryption_keys"].as_array().unwrap();
    assert_eq!(keys.len(), 2);
    for k in keys {
        assert_eq!(k["bind"], "project");
        assert_eq!(k["caller"], "predecessor");
    }
    assert!(keys.iter().any(|k| k["path"] == "loan-terms-v2"));
    assert!(keys.iter().any(|k| k["path"] == "truenav-report-v3"));
}

#[cfg(feature = "dry-run-tests")]
#[test]
fn explicit_dry_run_engine_envelope_fails_normal_frozen_validation() {
    let (mut c, mut s, p, r) = setup(0);
    let overlay: Value = serde_json::from_str(include_str!(
        "../../../receipts/tests/deploy-context.dryrun.json"
    ))
    .unwrap();
    c.scope.receipts_contract = overlay["receipts_contract"].as_str().unwrap().into();
    for source in &mut s {
        source.scope = c.scope.clone();
        sign(source);
    }
    let out = evaluate(&c, &s, &p, &r, &TestMac, &salt()).unwrap();
    assert!(validate(&out.envelope).is_err());
    truenav_v3_core::wire::validate_dry_run(&out.envelope, true).unwrap();
    assert_eq!(out.envelope["score"], 99);
    println!("DRY_RUN: engine dev-account envelope rejected by normal frozen validation");
}

#[test]
fn unsupported_second_lien_never_hides_a_proven_first_lien_conflict() {
    let (c, mut s, p, mut r) = setup(0);
    s[0].payload["loans"][0]["lien_rank"] = json!(2);
    s[3].payload["loan_terms"][0]["lien_rank"] = json!(2);
    sign(&mut s[0]);
    sign(&mut s[3]);
    r.snapshot.locks[0].owner = Some("another-fund.sim.testnet".into());
    r.snapshot.locks[0].fund_token_id = Some("another-fund".into());
    let second_only = evaluate(&c, &s, &p, &r, &TestMac, &salt()).unwrap();
    assert_eq!(second_only.envelope["pledge_result"], "conflict");
    r.snapshot.locks[1].owner = Some("another-fund.sim.testnet".into());
    r.snapshot.locks[1].fund_token_id = Some("another-fund".into());
    let mixed = evaluate(&c, &s, &p, &r, &TestMac, &salt()).unwrap();
    assert_eq!(mixed.envelope["pledge_result"], "conflict");
    assert!(mixed.envelope["holds"]
        .as_array()
        .unwrap()
        .contains(&json!("second_lien_unsupported")));
}

#[test]
fn a_missing_certificate_cannot_erase_registered_manager_membership() {
    let f: Value = serde_json::from_str(include_str!("../../../spec/nav/fixtures.json")).unwrap();
    let mut fund = f["funds"][0].clone();
    fund["certificate"] = Value::Null;
    fund["registry_manager_id"] = json!("registered-test-manager");
    let at = truenav_v3_core::timestamp(f["valuation_time"].as_str().unwrap()).unwrap();
    let n = nav::score(&fund, at, &json!([]));
    assert_eq!(n.manager.as_deref(), Some("registered-test-manager"));
    assert_eq!(n.status, "not_rated");
}

#[test]
fn same_loan_in_two_funds_caps_previously_97_to_59_and_red() {
    let (c, sources, p, mut r) = temporal_setup();
    let before = evaluate(&c, &sources, &p, &r, &TestMac, &salt()).unwrap();
    assert_eq!(before.envelope["score"], 97);
    // Registry proves this exact terms fingerprint is actively locked to another fund.
    r.snapshot.locks[5].owner = Some("other.sim.testnet".into());
    r.snapshot.locks[5].fund_token_id = Some("other-simulated-fund".into());
    let conflict = evaluate(&c, &sources, &p, &r, &TestMac, &salt()).unwrap();
    assert_eq!(conflict.envelope["pledge_result"], "conflict");
    assert_eq!(conflict.envelope["score"], 59);
    assert_eq!(conflict.envelope["band"], "red");
    assert_eq!(conflict.private_report["score_x100"], 5900);
    assert!(conflict.envelope["caps"]
        .as_array()
        .unwrap()
        .contains(&json!("pledge_conflict")));
    assert!(
        conflict.private_report["raw_score"]
            .as_str()
            .unwrap()
            .parse::<f64>()
            .unwrap()
            > 59.0
    );
    let (mut c2, mut s2, mut p2, mut r2) = setup(0);
    c2.scope.token_id = "other-simulated-fund".into();
    c2.scope.fund_id = c2.scope.token_id.clone();
    c2.scope.fund_account = "other.sim.testnet".into();
    for k in &mut p2.source_registry.keys {
        k.fund_scope.push(c2.scope.token_id.clone());
    }
    for s in &mut s2 {
        s.scope = c2.scope.clone();
    }
    // Both source-signed tapes name the same loan terms. File names do not enter the identity.
    s2[0].payload["loans"][0]["terms"] = sources[0].payload["loans"][5]["terms"].clone();
    s2[3].payload["loan_terms"][0]["terms"] = sources[3].payload["loan_terms"][5]["terms"].clone();
    for s in &mut s2 {
        sign(s);
    }
    s2[2].payload["fund"]["fund_id"] = json!(c2.scope.token_id);
    s2[0].payload["loans"][0]["principal"] = json!(100000);
    for s in &mut s2 {
        sign(s);
    }
    for lock in &mut r2.snapshot.locks {
        lock.owner = Some(c2.scope.fund_account.clone());
        lock.fund_token_id = Some(c2.scope.token_id.clone());
    }
    r2.snapshot.locks[0] = r.snapshot.locks[5].clone();
    let owner = evaluate(&c2, &s2, &p2, &r2, &TestMac, &salt()).unwrap();
    assert_ne!(owner.envelope["pledge_result"], "conflict");
    assert!(!owner.envelope["caps"]
        .as_array()
        .unwrap()
        .contains(&json!("pledge_conflict")));
}
#[test]
fn unknown_second_lien_has_a_visible_hold_without_a_conflict_cap() {
    let (c, mut s, p, r) = setup(0);
    s[0].payload["loans"][0]["lien_rank"] = json!(2);
    s[3].payload["loan_terms"][0]["lien_rank"] = json!(2);
    sign(&mut s[0]);
    sign(&mut s[3]);
    let out = evaluate(&c, &s, &p, &r, &TestMac, &salt()).unwrap();
    assert_eq!(out.envelope["pledge_result"], "unknown");
    assert!(out.envelope["holds"]
        .as_array()
        .unwrap()
        .contains(&json!("second_lien_unsupported")));
    assert!(!out.envelope["caps"]
        .as_array()
        .unwrap()
        .contains(&json!("pledge_conflict")));
}

/// A foreign lock on the same terms must cap the score even when the tape calls the position a second lien.
#[test]
fn redteam_r1_second_lien_of_another_funds_loan_must_cap_at_59() {
    let (c, mut s, p, mut r) = temporal_setup();
    s[0].payload["loans"][5]["lien_rank"] = json!(2);
    s[3].payload["loan_terms"][5]["lien_rank"] = json!(2);
    r.snapshot.locks[5].owner = Some("other.sim.testnet".into());
    r.snapshot.locks[5].fund_token_id = Some("other-simulated-fund".into());
    for src in &mut s {
        sign(src);
    }
    let out = evaluate(&c, &s, &p, &r, &TestMac, &salt()).unwrap();
    assert!(
        out.envelope["caps"]
            .as_array()
            .unwrap()
            .contains(&json!("pledge_conflict")),
        "pledge_result={} score={}",
        out.envelope["pledge_result"],
        out.envelope["score"]
    );
    assert!(out.envelope["score"].as_u64().unwrap_or(100) <= 59);
    assert_eq!(out.envelope["band"], "red");
}

/// A one-cent change of signed principal must not mint a fresh fingerprint that drops the conflict cap.
#[test]
fn redteam_r1_one_cent_term_edit_must_not_escape_pledge_conflict() {
    let (c, mut sources, p, mut r) = temporal_setup();
    r.snapshot.locks[5].owner = Some("other.sim.testnet".into());
    r.snapshot.locks[5].fund_token_id = Some("other-simulated-fund".into());
    let conflicted = evaluate(&c, &sources, &p, &r, &TestMac, &salt()).unwrap();
    assert_eq!(conflicted.envelope["score"], 59);
    let mut terms = sources[3].payload["loan_terms"][5]["terms"].clone();
    let cents = terms["principal_cents"]
        .as_str()
        .unwrap()
        .parse::<u128>()
        .unwrap()
        + 1;
    terms["principal_cents"] = json!(cents.to_string());
    sources[0].payload["loans"][5]["terms"] = terms.clone();
    sources[3].payload["loan_terms"][5]["terms"] = terms.clone();
    let edited: LoanTerms = serde_json::from_value(terms).unwrap();
    r.snapshot.locks[5].fingerprint = fingerprint(&edited, "real_estate", &[], &TestMac).unwrap();
    r.snapshot.locks[5].owner = None;
    r.snapshot.locks[5].fund_token_id = None;
    for src in &mut sources {
        sign(src);
    }
    let out = evaluate(&c, &sources, &p, &r, &TestMac, &salt()).unwrap();
    assert!(
        !out.envelope["caps"]
            .as_array()
            .unwrap()
            .contains(&json!("pledge_conflict")),
        "a principal edit is not a double pledge"
    );
    assert!(out.envelope["exceptions"]
        .as_array()
        .unwrap()
        .iter()
        .any(|x| x["code"] == "terms_mismatch"));
    assert_ne!(out.envelope["pledge_result"], "conflict");
    assert!(out.envelope["score"].as_u64().unwrap_or(100) <= 59);
    assert_eq!(out.envelope["band"], "red");
}

/// NAV principal is the figure investors rely on, so it has to be the signed terms principal.
#[test]
fn redteam_r1_tape_principal_must_match_signed_terms() {
    let (c, mut s, p, r) = temporal_setup();
    s[0].payload["loans"][5]["principal"] = json!(200_000.0);
    sign(&mut s[0]);
    let out = evaluate(&c, &s, &p, &r, &TestMac, &salt()).unwrap();
    assert!(
        !out.envelope["caps"]
            .as_array()
            .unwrap()
            .contains(&json!("pledge_conflict")),
        "a tape mismatch is not a double pledge"
    );
    assert!(out.envelope["exceptions"]
        .as_array()
        .unwrap()
        .iter()
        .any(|x| x["code"] == "terms_mismatch"));
    assert_ne!(out.envelope["pledge_result"], "conflict");
    assert!(out.envelope["score"].as_u64().unwrap_or(100) <= 59);
    assert_eq!(out.envelope["band"], "red");
}

/// The same collateral ref in two namespaces is two loans. The same namespace and ref across funds is one pledge.
#[test]
fn collateral_namespace_scopes_pledge_conflict() {
    let (c, sources, p, mut r) = temporal_setup();
    let ours = r.snapshot.locks[5].fingerprint.clone();
    let mut other_terms = sources[3].payload["loan_terms"][5]["terms"].clone();
    other_terms["collateral_namespace"] = json!("county-b");
    let other: LoanTerms = serde_json::from_value(other_terms).unwrap();
    let other_fp = fingerprint(&other, "real_estate", &[], &TestMac).unwrap();
    assert_ne!(
        ours, other_fp,
        "another namespace must not share this pledge hash"
    );
    let clear = evaluate(&c, &sources, &p, &r, &TestMac, &salt()).unwrap();
    assert_ne!(clear.envelope["pledge_result"], "conflict");
    assert!(!clear.envelope["caps"]
        .as_array()
        .unwrap()
        .contains(&json!("pledge_conflict")));
    r.snapshot.locks[5].owner = Some("other.sim.testnet".into());
    r.snapshot.locks[5].fund_token_id = Some("other-simulated-fund".into());
    let hit = evaluate(&c, &sources, &p, &r, &TestMac, &salt()).unwrap();
    assert_eq!(hit.envelope["pledge_result"], "conflict");
    assert!(hit.envelope["caps"]
        .as_array()
        .unwrap()
        .contains(&json!("pledge_conflict")));
    assert!(hit.envelope["score"].as_u64().unwrap() <= 59);
    assert_eq!(hit.envelope["band"], "red");
}

/// A lock whose hash is the pledge module's v4 message is the lock the NAV check reads.
#[test]
fn redteam_r1d_pledge_path_lock_is_seen_by_the_nav_check() {
    let (c, sources, p, mut r) = temporal_setup();
    let t: LoanTerms =
        serde_json::from_value(sources[3].payload["loan_terms"][5]["terms"].clone()).unwrap();
    let message =
        pledge_message("real_estate", &t.collateral_namespace, &t.collateral_ref).unwrap();
    let lock = hex::encode(TestMac.mac(&message).unwrap());
    assert_eq!(lock, r.snapshot.locks[5].fingerprint);
    r.snapshot.locks[5].owner = Some("other.sim.testnet".into());
    r.snapshot.locks[5].fund_token_id = Some("other-simulated-fund".into());
    let out = evaluate(&c, &sources, &p, &r, &TestMac, &salt()).unwrap();
    assert!(
        out.envelope["caps"]
            .as_array()
            .unwrap()
            .contains(&json!("pledge_conflict")),
        "pledge_result={} score={}",
        out.envelope["pledge_result"],
        out.envelope["score"]
    );
    assert!(out.envelope["score"].as_u64().unwrap_or(100) <= 59);
    assert_eq!(out.envelope["band"], "red");
}

#[test]
fn redteam_r1b_signed_origination_change_must_cap() {
    let (c, mut sources, p, r) = temporal_setup();
    let mut terms = sources[3].payload["loan_terms"][5]["terms"].clone();
    terms["origination_date"] = json!("2020-06-01");
    sources[0].payload["loans"][5]["terms"] = terms.clone();
    sources[3].payload["loan_terms"][5]["terms"] = terms;
    sign(&mut sources[0]);
    sign(&mut sources[3]);
    let out = evaluate(&c, &sources, &p, &r, &TestMac, &salt()).unwrap();
    assert!(
        out.envelope["exceptions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|x| x["code"] == "terms_mismatch"),
        "score {} band {} exceptions {}",
        out.envelope["score"],
        out.envelope["band"],
        out.envelope["exceptions"]
    );
    assert!(out.envelope["score"].as_u64().unwrap_or(100) <= 59);
    assert_eq!(out.envelope["band"], "red");
}

#[test]
fn redteam_r1b_repaid_tape_must_not_hide_a_foreign_lock() {
    let (c, mut sources, p, mut r) = temporal_setup();
    sources[0].payload["loans"][5]["repaid"] = json!(100000.0);
    r.snapshot.locks[5].owner = Some("other.sim.testnet".into());
    r.snapshot.locks[5].fund_token_id = Some("other-simulated-fund".into());
    sign(&mut sources[0]);
    let out = evaluate(&c, &sources, &p, &r, &TestMac, &salt()).unwrap();
    assert!(
        out.envelope["caps"]
            .as_array()
            .unwrap()
            .contains(&json!("pledge_conflict")),
        "pledge_result={} score={}",
        out.envelope["pledge_result"],
        out.envelope["score"]
    );
    assert!(out.envelope["score"].as_u64().unwrap_or(100) <= 59);
    assert_eq!(out.envelope["band"], "red");
}

#[test]
fn redteam_r1b_engine_must_read_the_migration_alias() {
    // The v1 alias cannot match a historical lock (different key path and project). It is not queried.
    let (c, sources, p, r) = temporal_setup();
    let t: LoanTerms =
        serde_json::from_value(sources[3].payload["loan_terms"][5]["terms"].clone()).unwrap();
    let hashes = pledge_lookup_hashes(&t, "real_estate", &[], &TestMac).unwrap();
    assert_eq!(hashes.len(), 1, "a v1 alias is still in the lookup list");
    struct Spy {
        inner: Read,
        primary: String,
    }
    impl RegistryReader for Spy {
        fn read(
            &self,
            scope: &Scope,
            fps: &[String],
            at: &str,
        ) -> truenav_v3_core::Result<Snapshot> {
            if fps.len() != self.inner.snapshot.locks.len() {
                return Err("alias_rows_still_queried");
            }
            if !fps.iter().any(|h| h == &self.primary) {
                return Err("primary_not_queried");
            }
            self.inner.read(scope, fps, at)
        }
    }
    let out = evaluate(
        &c,
        &sources,
        &p,
        &Spy {
            inner: r,
            primary: hashes[0].clone(),
        },
        &TestMac,
        &salt(),
    );
    match out {
        Err("alias_rows_still_queried") => panic!("engine still queries an alias row"),
        Ok(_) => {}
        Err(other) => panic!("engine failed: {other}"),
    }
}

/// RPC returns one row per queried hash, including a null row when get_lock is empty.
#[test]
fn rpc_shaped_lock_list_remaps_alias_hits() {
    use std::cell::Cell;
    let (c, sources, p, _) = setup(0);
    let loans = sources[0].payload["loans"].as_array().unwrap();
    let n = loans.len();
    let t: LoanTerms = serde_json::from_value(loans[0]["terms"].clone()).unwrap();
    let asset = loans[0]["asset"].as_str().unwrap();
    let id = loans[0]["id"].clone();
    let hashes = pledge_lookup_hashes(&t, asset, &[], &TestMac).unwrap();
    let primary = hashes[0].clone();
    struct RpcRows {
        live: BTreeMap<String, (String, String)>,
        queried: Cell<usize>,
    }
    impl RegistryReader for RpcRows {
        fn read(
            &self,
            scope: &Scope,
            fps: &[String],
            _: &str,
        ) -> truenav_v3_core::Result<Snapshot> {
            self.queried.set(fps.len());
            if scope.network != "near_testnet" {
                return Err("registry_snapshot_invalid");
            }
            let locks = fps
                .iter()
                .map(|fp| match self.live.get(fp) {
                    Some((fund, account)) => registry_lock(fp, Some(fund), Some(account)),
                    None => registry_lock(fp, None, None),
                })
                .collect();
            Ok(Snapshot {
                registry_account: "registry.tnlab-718ca9.testnet".into(),
                block_height: "123456".into(),
                block_hash: "TEST_ONLY_finalized_block".into(),
                finalized: true,
                manager_id: "mgr-harbor.demo".into(),
                locks,
                attempts: json!([]),
                certificate_history: json!([]),
                manager_funds: vec![],
                manager_attempt_log: json!({}),
            })
        }
    }
    let detail = |out: &Output, key: &str| {
        out.private_report["pledge_detail"]["loans"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["loan_id"] == id)
            .unwrap()[key]
            .clone()
    };
    let run = |live: BTreeMap<String, (String, String)>| {
        let reader = RpcRows {
            live,
            queried: Cell::new(0),
        };
        let out = evaluate(&c, &sources, &p, &reader, &TestMac, &salt()).unwrap();
        assert_eq!(
            reader.queried.get(),
            n,
            "registry read was not one row per loan"
        );
        out
    };
    let none = run(BTreeMap::new());
    assert_ne!(none.envelope["pledge_result"], "conflict");
    assert_eq!(detail(&none, "completed"), json!(false));
    let mut own_primary = BTreeMap::new();
    own_primary.insert(
        primary.clone(),
        (c.scope.token_id.clone(), c.scope.fund_account.clone()),
    );
    let owned = run(own_primary);
    assert_ne!(owned.envelope["pledge_result"], "conflict");
    assert_eq!(detail(&owned, "completed"), json!(true));
    assert_eq!(detail(&owned, "owner"), json!(c.scope.fund_account));
    let mut foreign_primary = BTreeMap::new();
    foreign_primary.insert(
        primary,
        ("other-simulated-fund".into(), "other.sim.testnet".into()),
    );
    let foreign = run(foreign_primary);
    assert_eq!(foreign.envelope["pledge_result"], "conflict");
    assert_eq!(foreign.envelope["band"], "red");
    assert!(foreign.envelope["score"]
        .as_u64()
        .map(|n| n <= 59)
        .unwrap_or(true));
}

struct LiveRegistry {
    live: BTreeMap<String, (String, String)>,
}
impl RegistryReader for LiveRegistry {
    fn read(&self, _: &Scope, fps: &[String], _: &str) -> truenav_v3_core::Result<Snapshot> {
        Ok(Snapshot {
            registry_account: "registry.tnlab-718ca9.testnet".into(),
            block_height: "123456".into(),
            block_hash: "TEST_ONLY_finalized_block".into(),
            finalized: true,
            manager_id: "mgr-harbor.demo".into(),
            locks: fps
                .iter()
                .map(|fp| match self.live.get(fp) {
                    Some((f, a)) => registry_lock(fp, Some(f), Some(a)),
                    None => registry_lock(fp, None, None),
                })
                .collect(),
            attempts: json!([]),
            certificate_history: json!([]),
            manager_funds: vec![],
            manager_attempt_log: json!({}),
        })
    }
}

#[test]
fn redteam_r2_engine_must_see_a_double_pledge_locked_through_the_pledge_module() {
    // The failing repro minted locks under a second HMAC key. After RT2-01 both sides use one
    // derivation, so the engine's TestMac is the pledge module's key in this harness.
    // tee/test/redteam-r2-keyscope.test.mjs proves the two manifests build that one string.
    let (c, sources, p, _) = setup(0);
    let loans = sources[0].payload["loans"].as_array().unwrap();
    let mut live = BTreeMap::new();
    for (i, l) in loans.iter().enumerate() {
        let t: LoanTerms = serde_json::from_value(l["terms"].clone()).unwrap();
        let h = fingerprint(&t, l["asset"].as_str().unwrap(), &[], &TestMac).unwrap();
        let holder = if i == 0 {
            (
                "other-simulated-fund".to_string(),
                "other.sim.testnet".to_string(),
            )
        } else {
            (c.scope.token_id.clone(), c.scope.fund_account.clone())
        };
        live.insert(h, holder);
    }
    let out = evaluate(&c, &sources, &p, &LiveRegistry { live }, &TestMac, &salt()).unwrap();
    assert_eq!(
        out.envelope["pledge_result"], "conflict",
        "loan 0 is pledged to another fund on chain, yet the NAV check reports pledge_result={} score={} band={} coverage_bps={}",
        out.envelope["pledge_result"], out.envelope["score"], out.envelope["band"], out.envelope["pledge_coverage_bps"]
    );
}

#[test]
fn redteam_r2_case_sensitive_namespace_must_keep_distinct_refs_distinct() {
    let t = |r: &str| LoanTerms {
        version: "loan-terms-v2".into(),
        borrower_namespace: "demo".into(),
        borrower_id: "B1".into(),
        origination_date: "2026-01-01".into(),
        principal_cents: "100".into(),
        currency: "USD".into(),
        collateral_namespace: "deeds".into(),
        collateral_ref: r.into(),
    };
    let ns = vec!["deeds".to_string()];
    assert_ne!(
        canonical_terms(&t("Ab-1"), &ns).unwrap()["collateral_ref"],
        canonical_terms(&t("aB-1"), &ns).unwrap()["collateral_ref"]
    );
    assert_ne!(
        fingerprint(&t("Ab-1"), "real_estate", &ns, &TestMac).unwrap(),
        fingerprint(&t("aB-1"), "real_estate", &ns, &TestMac).unwrap(),
        "fingerprint ignores case_sensitive_namespaces"
    );
}

#[test]
fn redteam_r2_migration_alias_must_be_able_to_match_a_historical_v1_lock() {
    // The recorded v1 module MACed `truenav-fp-v1|{asset}|{DOCUMENT}` under path loan-fingerprint
    // in the servicer project. That derivation is not loan-terms-v2 in the receipts engine project.
    // A second hash under the new key cannot find those locks, so the alias path is removed.
    // A historical lock has to be released and pledged again.
    struct Plain;
    impl Fingerprinter for Plain {
        fn mac(&self, m: &[u8]) -> truenav_v3_core::Result<[u8; 32]> {
            Ok(sha2_bytes(m))
        }
    }
    let raw = include_str!("../../../tee/fixtures/fingerprints.json");
    let v: Value = serde_json::from_str(raw).unwrap();
    let rec = &v["records"][0];
    let (asset, doc) = (
        rec["asset_type"].as_str().unwrap(),
        rec["document_id"].as_str().unwrap(),
    );
    let t = LoanTerms {
        version: "loan-terms-v2".into(),
        borrower_namespace: "demo".into(),
        borrower_id: "B1".into(),
        origination_date: "2026-01-01".into(),
        principal_cents: "100".into(),
        currency: "USD".into(),
        collateral_namespace: "demo".into(),
        collateral_ref: doc.into(),
    };
    let hashes = pledge_lookup_hashes(&t, asset, &[], &Plain).unwrap();
    assert_eq!(hashes.len(), 1, "the unsound v1 alias is still queried");
    let v1_module_message = format!("truenav-fp-v1|{asset}|{doc}");
    let historical: String = sha2_bytes(v1_module_message.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert!(
        !hashes.iter().any(|h| h == &historical),
        "lookup still pretends the historical v1 pipe string is a loan-terms-v2 hash"
    );
}

/// Registry keyed by fingerprint, like `get_lock`: an unknown fingerprint reads as an empty row.
struct KeyedRead {
    snapshot: Snapshot,
    rows: BTreeMap<String, LockRead>,
}
impl RegistryReader for KeyedRead {
    fn read(&self, _: &Scope, fp: &[String], _: &str) -> truenav_v3_core::Result<Snapshot> {
        let mut s = self.snapshot.clone();
        s.locks = fp
            .iter()
            .map(|f| {
                self.rows
                    .get(f)
                    .cloned()
                    .unwrap_or_else(|| registry_lock(f, None, None))
            })
            .collect();
        Ok(s)
    }
}

/// Codex audit A01: an invisible U+180F in signed terms gave a second fingerprint, hid another fund's
/// lock and moved the fund from 59 conflict red to 97 green. The variant must still hit the foreign lock.
#[test]
fn a01_invisible_u180f_must_not_hide_a_foreign_lock() {
    let (c, sources, p, r) = temporal_setup();
    let mut rows: BTreeMap<String, LockRead> = r
        .snapshot
        .locks
        .iter()
        .map(|l| (l.fingerprint.clone(), l.clone()))
        .collect();
    let foreign = r.snapshot.locks[5].fingerprint.clone();
    let row = rows.get_mut(&foreign).unwrap();
    row.owner = Some("other.sim.testnet".into());
    row.fund_token_id = Some("other-simulated-fund".into());
    let keyed = KeyedRead {
        snapshot: r.snapshot.clone(),
        rows: rows.clone(),
    };
    let honest = evaluate(&c, &sources, &p, &keyed, &TestMac, &salt()).unwrap();
    assert_eq!(honest.envelope["pledge_result"], "conflict");
    assert_eq!(honest.envelope["score"], 59);
    assert_eq!(honest.envelope["band"], "red");
    for invisible in ['\u{180f}', '\u{2065}', '\u{e0002}'] {
        let variant = LoanTerms {
            version: "loan-terms-v2".into(),
            borrower_namespace: "demo".into(),
            borrower_id: "TEST TEMPORAL 5".into(),
            origination_date: "2026-01-01".into(),
            principal_cents: "10000000".into(),
            currency: "USD".into(),
            collateral_namespace: "demo".into(),
            collateral_ref: format!("TEST TEMPORAL{invisible} 5"),
        };
        let tv = canonical_terms(&variant, &[]).unwrap();
        let mut s = sources.clone();
        s[0].payload["loans"][5]["terms"] = tv.clone();
        s[3].payload["loan_terms"][5]["terms"] = tv;
        for src in &mut s {
            sign(src);
        }
        let out = evaluate(&c, &s, &p, &keyed, &TestMac, &salt()).unwrap();
        let cp = invisible as u32;
        assert_eq!(
            out.envelope["pledge_result"], "conflict",
            "U+{cp:04X} hid the foreign lock: score {} band {}",
            out.envelope["score"], out.envelope["band"]
        );
        assert_eq!(out.envelope["score"], 59, "U+{cp:04X} lifted the score");
        assert_eq!(out.envelope["band"], "red", "U+{cp:04X} changed the band");
        assert!(out.envelope["caps"]
            .as_array()
            .unwrap()
            .contains(&json!("pledge_conflict")));
    }
}

/// Codex differential audit (14 Nov 2026): the JS engine and this NAV port must agree on the shared fixture,
/// which tests/security/nav-differential.test.mjs checks against JS. D1: an excluded loan with a missing repaid
/// is exposure for the 50% test only (R13), never a mark in the listed book (R1). D2: an expired claimed cash
/// attestation sets freshness to 0, also at cash 0 (R8).
#[test]
fn nav_differential_cases_match_the_js_engine() {
    let fx: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/nav-differential.json"
    ))
    .unwrap();
    let now = truenav_v3_core::timestamp(fx["now"].as_str().unwrap()).unwrap();
    let cents = |x: f64| (x * 100.0).round() as i64;
    for c in fx["cases"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let e = &c["expected"];
        let n = nav::score(&c["fund"], now, &json!([]));
        assert_eq!(n.status, e["status"].as_str().unwrap(), "{name}");
        let scored = n.status == "scored";
        let score = nav::half_up(n.raw);
        let band = if score >= 85 {
            "green"
        } else if score >= 60 {
            "yellow"
        } else {
            "red"
        };
        assert_eq!(
            if scored { json!(score) } else { Value::Null },
            e["score"],
            "{name}"
        );
        assert_eq!(
            if scored { json!(band) } else { Value::Null },
            e["band"],
            "{name}"
        );
        if let Some(f) = e["freshness"].as_f64() {
            assert_eq!(n.fresh, f, "{name}");
        }
        if let Some(l) = e["listed_book"].as_f64() {
            assert_eq!(cents(n.listed), cents(l), "{name}");
        }
        if let Some(d) = e["share_denominator"].as_f64() {
            let uv = e["unverified_value"].as_f64().unwrap();
            assert_eq!(cents(n.unverified_share.unwrap() * d), cents(uv), "{name}");
        }
    }
}

/// D1 through the full signed v3 pipeline: loans whose signed tape omits repaid must not enter the listed book
/// at principal + accrued. Before the fix the fake marks raised the 50% denominator and the fund scored.
#[test]
fn d1_missing_repaid_is_not_a_valuation_mark_in_the_signed_pipeline() {
    let (c, mut sources, p, r) = temporal_setup();
    let honest = evaluate(&c, &sources, &p, &r, &TestMac, &salt()).unwrap();
    assert_eq!(honest.envelope["status"], "scored");
    for i in 50..90 {
        sources[0].payload["loans"][i]
            .as_object_mut()
            .unwrap()
            .remove("repaid");
    }
    for s in &mut sources {
        sign(s);
    }
    let out = evaluate(&c, &sources, &p, &r, &TestMac, &salt()).unwrap();
    assert_eq!(
        out.envelope["status"], "disclaimed",
        "missing repaid scored {} {}",
        out.envelope["score"], out.envelope["band"]
    );
    assert_eq!(out.envelope["score"], Value::Null);
}
