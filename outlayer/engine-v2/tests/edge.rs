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
    assert_eq!(cs.len(), 14);
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
    assert_eq!(o["match"]["due"][0]["status"], "unpaid");
    assert_eq!(o["match"]["bank"][0]["outcome"], "settled_not_claimed");
    assert_eq!(o["match"]["bank"][0]["used_cents"], 0);
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
