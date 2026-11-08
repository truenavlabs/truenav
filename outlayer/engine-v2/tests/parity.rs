// The Rust port must turn each raw-data parity fixture's input into exactly its expected canonical output, byte for
// byte (spec/v2/SPEC.md section 10). The fixtures are written by the JS reference (cashflow/fixtures/make-parity.mjs).
use std::fs;
use truenav_engine_v2::base::SeedPseudonymizer;
use truenav_engine_v2::run::{parity_output, run_fund, RunOptions};

fn fixtures() -> Vec<(String, serde_json::Value)> {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../cashflow/fixtures/parity");
    let mut v: Vec<_> = fs::read_dir(dir).expect("fixture dir").map(|e| e.unwrap().path()).filter(|p| p.file_name().unwrap().to_str().unwrap().starts_with("cashflow-parity-")).collect();
    v.sort();
    v.into_iter().map(|p| (p.file_name().unwrap().to_str().unwrap().to_string(), serde_json::from_str(&fs::read_to_string(&p).unwrap()).unwrap())).collect()
}

fn run_fixture(fx: &serde_json::Value) -> String {
    let inp = &fx["input"];
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
    parity_output(&run_fund(&inp["dataset"], &p, &opts).expect("run")).expect("canonical")
}

#[test]
fn there_are_four_fixtures() {
    let names: Vec<String> = fixtures().into_iter().map(|(n, _)| n).collect();
    assert_eq!(names, ["cashflow-parity-DEMO-CREDIT.json", "cashflow-parity-DEMO-RENTAL.json", "cashflow-parity-HONEST-CREDIT.json", "cashflow-parity-HONEST-RENTAL.json"]);
}

#[test]
fn every_fixture_is_byte_identical() {
    for (name, fx) in fixtures() {
        let got = run_fixture(&fx);
        let want = fx["expected_output"].as_str().unwrap();
        if got != want {
            let at = got.bytes().zip(want.bytes()).position(|(a, b)| a != b).unwrap_or(got.len().min(want.len()));
            let lo = at.saturating_sub(120);
            panic!("{name}: first difference at byte {at}\n got: {}\nwant: {}", &got[lo..(at + 120).min(got.len())], &want[lo..(at + 120).min(want.len())]);
        }
    }
}

#[test]
fn a_one_cent_change_in_the_input_breaks_parity() {
    let (_, mut fx) = fixtures().into_iter().find(|(n, _)| n.contains("DEMO-RENTAL")).unwrap();
    let want = fx["expected_output"].as_str().unwrap().to_string();
    assert_eq!(run_fixture(&fx), want);
    let t = &mut fx["input"]["dataset"]["bank_feed"]["transactions"][0]["amount_cents"];
    *t = serde_json::json!(t.as_i64().unwrap() - 1);
    assert_ne!(run_fixture(&fx), want, "a changed input must not reproduce the expected bytes");
}

#[test]
fn output_lengths_match_the_reference() {
    for (name, fx) in fixtures() {
        let got = run_fixture(&fx);
        assert!(got.len() > 20_000, "{name}: suspiciously short output ({} bytes)", got.len());
        assert_eq!(got.len(), fx["expected_output"].as_str().unwrap().len(), "{name}");
    }
}
