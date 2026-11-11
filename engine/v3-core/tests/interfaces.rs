use ed25519_dalek::{Signer, SigningKey};
use serde_json::{json, Value};
use truenav_v3_core::source::*;
use truenav_v3_core::{canonical, envelope_hash, hash, parse, timestamp, validate};
fn read(s: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(format!("../../{s}")).unwrap()).unwrap()
}
#[test]
fn frozen_serialization_goldens() {
    let g = read("schema/vectors/receipt-v3-golden.json");
    for v in g["vectors"].as_array().unwrap() {
        let e = &v["envelope"];
        validate(e).unwrap();
        assert_eq!(envelope_hash(e).unwrap(), e["receipt_sha256"]);
        assert_eq!(
            hex::encode(
                canonical(&{
                    let mut e = e.clone();
                    e.as_object_mut().unwrap().remove("receipt_sha256");
                    e
                })
                .unwrap()
            ),
            v["receipt_preimage_hex"]
        );
    }
}
#[test]
fn duplicate_keys_and_dates_fail_closed() {
    assert!(parse(br#"{"score":1,"score":2}"#).is_err());
    for t in [
        "2026-02-29T00:00:00Z",
        "2026-04-31T00:00:00Z",
        "2026-11-10T24:00:00Z",
        "2026-13-01T00:00:00Z",
    ] {
        assert!(timestamp(t).is_err())
    }
    assert!(timestamp("2028-02-29T00:00:00Z").is_ok());
}
#[test]
fn commitment_known_answers() {
    let k = read("schema/vectors/commitment-known-answers.json");
    for v in k["vectors"].as_array().unwrap() {
        assert_eq!(
            commitment(
                v["label"].as_str().unwrap(),
                &v["value"],
                &[0; 32],
                &[0; 32]
            )
            .unwrap(),
            v["sha256"]
        );
    }
}
#[test]
fn rfc8032_source_known_answer() {
    let v = read("schema/vectors/source-signature-known-answer.json");
    let s = SignedSource {
        source: v["source"].as_str().unwrap().into(),
        key_id: v["key_id"].as_str().unwrap().into(),
        scope: serde_json::from_value(v["scope"].clone()).unwrap(),
        period: serde_json::from_value(v["period"].clone()).unwrap(),
        revision: v["revision"].as_str().unwrap().into(),
        data_as_of: v["data_as_of"].as_str().unwrap().into(),
        payload: v["payload"].clone(),
        payload_sha256: v["payload_sha256"].as_str().unwrap().into(),
        signature: v["signature_hex"].as_str().unwrap().into(),
    };
    assert_eq!(hex::encode(source_preimage(&s).unwrap()), v["preimage_hex"]);
    let key = SourceKey {
        key_id: s.key_id.clone(),
        role: s.source.clone(),
        fund_scope: vec![s.scope.token_id.clone()],
        public_key: format!("ed25519:{}", v["public_key_hex"].as_str().unwrap()),
        valid_from: "2026-01-01T00:00:00Z".into(),
        valid_until: "2027-01-01T00:00:00Z".into(),
        revoked: false,
    };
    verify_source(
        &s,
        &Registry {
            registry_version: "truenav-src-v1".into(),
            keys: vec![key],
        },
        &s.scope,
        &s.period,
        1,
    )
    .unwrap();
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
#[test]
fn public_test_registry_matches_runtime_keys() {
    let registry: Registry =
        serde_json::from_str(include_str!("fixtures/source-registry.TEST.json")).unwrap();
    for k in &registry.keys {
        assert_eq!(
            k.public_key,
            format!(
                "ed25519:{}",
                hex::encode(test_key(&k.role).verifying_key().as_bytes())
            )
        );
    }
    registry.check().unwrap();
    let v = serde_json::to_value(&registry).unwrap();
    let path = "tests/fixtures/source-registry.TEST.json";
    if std::env::var_os("TRUENAV_WRITE_PUBLIC_TEST_REGISTRY").is_some() {
        std::fs::write(path, serde_json::to_string_pretty(&v).unwrap() + "\n").unwrap();
    }
    assert_eq!(
        v,
        serde_json::from_str::<Value>(&std::fs::read_to_string(path).unwrap()).unwrap()
    );
}
#[test]
fn reject_unknown_forged_revoked_expired_scope_and_revision() {
    let role = "servicer";
    let key = test_key(role);
    let scope = Scope {
        network: "near_testnet".into(),
        receipts_contract: "receipts.tnlab-718ca9.testnet".into(),
        fund_account: "harbor.sim.testnet".into(),
        token_id: "harbor-credit-fund".into(),
        fund_id: "harbor-credit-fund".into(),
    };
    let period = Period {
        period_start: "2026-10-01".into(),
        period_end: "2026-11-01".into(),
    };
    let payload = json!({"private":"never echo financial inputs"});
    let mut s = SignedSource {
        source: role.into(),
        key_id: "servicer:sim:v1".into(),
        scope: scope.clone(),
        period: period.clone(),
        revision: "1".into(),
        data_as_of: "2026-11-09T06:00:00Z".into(),
        payload_sha256: hash(canonical(&payload).unwrap().as_bytes()),
        payload,
        signature: String::new(),
    };
    s.signature = hex::encode(
        key.sign(&sha2_bytes(&source_preimage(&s).unwrap()))
            .to_bytes(),
    );
    let mut registry = Registry {
        registry_version: "truenav-src-v1".into(),
        keys: vec![SourceKey {
            key_id: s.key_id.clone(),
            role: role.into(),
            fund_scope: vec![scope.token_id.clone()],
            public_key: format!("ed25519:{}", hex::encode(key.verifying_key().as_bytes())),
            valid_from: "2026-01-01T00:00:00Z".into(),
            valid_until: "2027-01-01T00:00:00Z".into(),
            revoked: false,
        }],
    };
    verify_source(&s, &registry, &scope, &period, 1).unwrap();
    assert_eq!(
        verify_source(&s, &registry, &scope, &period, 2),
        Err("source_revision_replay")
    );
    registry.keys[0].revoked = true;
    assert_eq!(
        verify_source(&s, &registry, &scope, &period, 1),
        Err("source_key_revoked")
    );
    registry.keys[0].revoked = false;
    registry.keys[0].valid_until = "2026-11-01T00:00:00Z".into();
    assert_eq!(
        verify_source(&s, &registry, &scope, &period, 1),
        Err("source_key_expired")
    );
    registry.keys[0].valid_until = "2027-01-01T00:00:00Z".into();
    let mut wrong = scope.clone();
    wrong.token_id = "other-fund".into();
    assert_eq!(
        verify_source(&s, &registry, &wrong, &period, 1),
        Err("source_scope_mismatch")
    );
    s.payload["private"] = json!("forged");
    assert_eq!(
        verify_source(&s, &registry, &scope, &period, 1),
        Err("source_signature_invalid")
    );
    s.key_id = "servicer:unknown:v1".into();
    assert_eq!(
        verify_source(&s, &registry, &scope, &period, 1),
        Err("source_key_unknown")
    );
}
#[test]
fn fingerprint_normalization_resists_renamed_document() {
    let terms = LoanTerms {
        version: "loan-terms-v2".into(),
        borrower_namespace: "demo".into(),
        borrower_id: "  borrower   a ".into(),
        origination_date: "2026-01-02".into(),
        principal_cents: "12345".into(),
        currency: "USD".into(),
        collateral_namespace: "demo".into(),
        collateral_ref: " ref-a ".into(),
    };
    let a = loan_terms_message(&terms, &[]).unwrap();
    let mut other = terms.clone();
    other.borrower_id = "BORROWER A".into();
    other.collateral_ref = "REF-A".into();
    assert_eq!(a, loan_terms_message(&other, &[]).unwrap());
    other.principal_cents = "12346".into();
    assert_ne!(a, loan_terms_message(&other, &[]).unwrap());
    other.origination_date = "2026-02-30".into();
    assert!(loan_terms_message(&other, &[]).is_err());
    assert_eq!(
        normalized_id("A\u{200b}B", false).unwrap(),
        normalized_id("AB", false).unwrap()
    );
    assert_eq!(normalized_id("e\u{301}", false).unwrap(), "é");
}

#[cfg(feature = "dry-run-tests")]
#[test]
fn dry_run_overlay_is_explicit_and_normal_validation_rejects_it() {
    let mut e = read("schema/vectors/receipt-v3-golden.json")["vectors"][0]["envelope"].clone();
    let overlay = read("receipts/tests/deploy-context.dryrun.json");
    e["receipts_contract"] = overlay["receipts_contract"].clone();
    truenav_v3_core::wire::seal_envelope(&mut e).unwrap();
    assert!(validate(&e).is_err());
    assert!(truenav_v3_core::wire::validate_dry_run(&e, false).is_err());
    truenav_v3_core::wire::validate_dry_run(&e, true).unwrap();
    e["method_version"] = json!("other");
    assert!(truenav_v3_core::wire::validate_dry_run(&e, true).is_err());
    println!("DRY_RUN: explicit test-only overlay; frozen validation rejects this account");
}

#[test]
fn canonical_private_precision_roundtrips_without_changing_commitments() {
    for x in [
        39.166666666666664,
        42.84303887485261,
        14.322624058656249,
        0.1,
        9.999999999999998,
    ] {
        let v = json!({"precision":x});
        let bytes = canonical(&v).unwrap();
        let decoded = parse(bytes.as_bytes()).unwrap();
        assert_eq!(v, decoded);
        assert_eq!(bytes, canonical(&decoded).unwrap());
    }
}

#[test]
fn private_score_decimal_is_plain_canonical_text() {
    for (x, want) in [
        (99.16666666666667, "99.16666666666667"),
        (1e-7, "0.0000001"),
        (1e21, "1000000000000000000000"),
        (-1e-7, "-0.0000001"),
        (-0.0, "0"),
    ] {
        assert_eq!(truenav_v3_core::wire::decimal(x).unwrap(), want)
    }
    assert!(truenav_v3_core::wire::decimal(f64::NAN).is_err());
}

#[test]
fn method_versions_select_only_their_own_schema_and_artifact() {
    use truenav_v3_core::wire::*;
    assert_eq!(
        hash(SCHEMA.as_bytes()),
        "bca1694674e7232fb53797a494ca84b0702bcf6908a14de9eb953061d5b114b2"
    );
    let mut e = read("schema/vectors/receipt-v3-golden.json")["vectors"][0]["envelope"].clone();
    e["pledge_result"] = json!("conflict");
    e["caps"] = json!(["pledge_conflict"]);
    e["score"] = json!(59);
    e["band"] = json!("red");
    seal_envelope(&mut e).unwrap();
    assert!(validate(&e).is_err());
    e["method_version"] = json!(CURRENT_METHOD);
    e["fund_id"] = e["token_id"].clone();
    seal_envelope(&mut e).unwrap();
    assert_eq!(validate(&e), Err("method_hash_mismatch"));
    e["method_spec_sha256"] = json!(method_hash_for(CURRENT_METHOD).unwrap());
    seal_envelope(&mut e).unwrap();
    validate(&e).unwrap();
    let v0: Value = serde_json::from_str(SCHEMA).unwrap();
    let v1: Value = serde_json::from_str(SCHEMA_V301).unwrap();
    assert!(validate_schema(&e, &v0).is_err());
    validate_schema(&e, &v1).unwrap();
    for (k, v) in [
        ("score", json!(97)),
        ("band", json!("green")),
        ("caps", json!([])),
        ("pledge_result", json!("unknown")),
    ] {
        let mut bad = e.clone();
        bad[k] = v;
        seal_envelope(&mut bad).unwrap();
        assert!(validate(&bad).is_err());
    }
}
#[test]
fn source_registries_reject_duplicates_rebinding_and_fixture_live_mixing() {
    let fixture: Registry =
        serde_json::from_str(include_str!("fixtures/source-registry.TEST.json")).unwrap();
    let mut session = RegistrySession::new(false);
    session.load(&fixture).unwrap();
    let mut changed = fixture.clone();
    changed.keys[0].public_key = changed.keys[1].public_key.clone();
    assert_eq!(session.load(&changed), Err("source_key_rebound"));
    let mut duplicate = fixture.clone();
    duplicate.keys.push(duplicate.keys[0].clone());
    assert!(duplicate.check().is_err());
    let mut live = fixture.clone();
    for k in &mut live.keys {
        k.key_id = format!("{}:live_test123:v1", k.role);
    }
    let mut runtime = RegistrySession::new(true);
    runtime.load(&live).unwrap();
    assert!(runtime.load(&fixture).is_err());
    assert!(session.load(&live).is_err());
    let mut mixed = fixture.clone();
    mixed.keys.push(live.keys[0].clone());
    assert!(mixed.check().is_err());
}
