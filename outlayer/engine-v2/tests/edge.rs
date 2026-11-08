// Edge cases written by the JS reference (cashflow/fixtures/make-edge.mjs): the Rust port must give exactly the
// expected canonical output, or fail with exactly the expected named code. Covers M5 (a mapped payer's credit that
// settles no claim), source validation up front, and UTC normalization of offset timestamps.
use serde_json::Value;
use std::fs;
use truenav_engine_v2::base::SeedPseudonymizer;
use truenav_engine_v2::run::{parity_output, run_fund, validation_code, RunOptions};

fn cases() -> Vec<Value> {
    let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../../cashflow/fixtures/edge/cashflow-edge-cases.json");
    let f: Value = serde_json::from_str(&fs::read_to_string(p).unwrap()).unwrap();
    f["cases"].as_array().unwrap().clone()
}

fn run(c: &Value) -> Result<String, String> {
    let inp = &c["input"];
    let o = &inp["options"];
    let opts = RunOptions {
        as_of: o["asOf"].as_str().unwrap(),
        period: o["period"].as_str().unwrap(),
        days_in_period: o["daysInPeriod"].as_i64().unwrap(),
        bank_fetched_at: o["bankFetchedAt"].as_str().unwrap(),
        previous: vec![],
        new_period: false,
    };
    let p = SeedPseudonymizer(inp["pseudonym_seed"].as_str().unwrap().as_bytes().to_vec());
    run_fund(&inp["dataset"], &p, &opts).map(|r| parity_output(&r).unwrap())
}

#[test]
fn every_edge_case_matches_the_reference_exactly() {
    let cs = cases();
    assert_eq!(cs.len(), 27);
    for c in &cs {
        let name = c["name"].as_str().unwrap();
        match (run(c), &c["expected"]) {
            (Ok(got), e) if e.get("output").is_some() => assert_eq!(got, e["output"].as_str().unwrap(), "{name}"),
            (Err(err), e) if e.get("error").is_some() => {
                assert_eq!(err, e["error"].as_str().unwrap(), "{name}");
                assert_eq!(validation_code(&err), Some(e["error"].as_str().unwrap()), "{name}: the TEE prints this code");
            }
            (got, e) => panic!("{name}: got {got:?}, want {e}"),
        }
    }
}

#[test]
fn m5_case_keeps_the_credit_out_of_cash_and_collection() {
    let c = cases().into_iter().find(|c| c["name"] == "m5_mapped_payer_credit_without_claim").unwrap();
    let o: Value = serde_json::from_str(&run(&c).unwrap()).unwrap();
    let oct = o["match"]["due"].as_array().unwrap().iter().find(|d| d["period"] == "2026-10").unwrap().clone();
    assert_eq!(oct["status"], "unpaid");
    let credit = o["match"]["bank"].as_array().unwrap().iter().find(|t| t["posted_date"] == "2026-10-02").unwrap().clone();
    assert_eq!(credit["outcome"], "settled_not_claimed");
    assert_eq!(credit["used_cents"], 0);
    assert_eq!(o["metrics"]["cash_received_cents"], 0);
    assert_eq!(o["metrics"]["collection_rate_bps"], 0);
}

#[test]
fn to_utc_normalizes_offsets_and_refuses_the_rest() {
    use truenav_engine_v2::base::to_utc;
    assert_eq!(to_utc("2026-11-01T05:00:00+07:00").as_deref(), Some("2026-10-31T22:00:00Z"));
    assert_eq!(to_utc("2026-10-31T17:00:00-05:00").as_deref(), Some("2026-10-31T22:00:00Z"));
    assert_eq!(to_utc("2026-10-31").as_deref(), Some("2026-10-31T00:00:00Z"));
    assert_eq!(to_utc("2026-10-31T22:00:00.250+01:00").as_deref(), Some("2026-10-31T21:00:00.250Z"));
    assert_eq!(to_utc("2024-02-29T00:00:00Z").as_deref(), Some("2024-02-29T00:00:00Z"));
    for bad in ["2026-02-30", "2026-10-31T24:00:00Z", "2026-10-31T22:00:00", "2026-10-31T22:00Z", "2026-10-31T22:00:00+0700", "1969-12-31T23:59:59Z", "2026-13-01", "", "2026-10-31T22:00:00+24:00", "2026-10-31t22:00:00Z"] {
        assert_eq!(to_utc(bad), None, "{bad}");
    }
}

#[test]
fn collection_cases_read_as_the_spec_says() {
    let get = |name: &str| -> Value {
        let c = cases().into_iter().find(|c| c["name"] == name).unwrap();
        serde_json::from_str(&run(&c).unwrap()).unwrap()
    };
    let gap = get("collection_gap_one_unit_100_cents");
    assert_eq!((gap["score"]["uncapped_score"].as_i64(), gap["score"]["score"].as_i64(), gap["score"]["band"].as_str()), (Some(100), Some(59), Some("red")));
    assert_eq!(gap["score"]["caps"][0]["code"], "collection_shortfall");
    assert_eq!(gap["score"]["caps"][0]["reason"], "red because of unverified collection: 0.00% of contractual dues for 2026-10 were bank-confirmed by 2026-11-07 (at least 90.00% needed)");
    assert!(!gap.to_string().to_lowercase().contains("default"));
    assert_eq!(get("collection_exactly_90_percent")["score"]["band"], "green");
    assert_eq!(get("collection_89_99_percent")["score"]["caps"][0]["code"], "collection_shortfall");
    assert_eq!(get("collection_rounds_to_90_but_below")["metrics"]["collection"]["rate_bps"], 9000);
    assert_eq!(get("collection_rounds_to_90_but_below")["score"]["score"], 59);
    let zero = get("collection_zero_dues_not_applicable");
    assert_eq!(zero["metrics"]["collection"]["status"], "not_applicable");
    assert_eq!(zero["metrics"]["collection"]["rate_bps"], Value::Null);
    assert_eq!(zero["score"]["holds"][0]["code"], "collection_not_applicable");
    assert_ne!(zero["score"]["band"], "green");
    let early = get("collection_pending_before_cutoff");
    assert_eq!(early["metrics"]["collection"]["status"], "pending");
    assert_eq!(early["score"]["holds"][0]["code"], "collection_pending");
    assert_ne!(early["score"]["band"], "green");
}
