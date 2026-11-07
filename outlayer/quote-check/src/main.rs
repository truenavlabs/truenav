// Spike: does dcap-qvl verify an Intel TDX quote when built for wasm32-wasip2 (OutLayer's target)?
// stdin: {"quote_hex": "...", "collateral": <QuoteCollateralV3 JSON>, "now_secs": N}; stdout: TCB status or error.
use std::io::Read;

#[derive(serde::Deserialize)]
struct Input {
    quote_hex: String,
    collateral: dcap_qvl::QuoteCollateralV3,
    now_secs: u64,
}

fn main() {
    let mut s = String::new();
    std::io::stdin().read_to_string(&mut s).unwrap();
    let input: Input = match serde_json::from_str(&s) { Ok(i) => i, Err(e) => { println!("{{\"error\":\"input: {e}\"}}"); return; } };
    let quote = hex::decode(input.quote_hex.trim_start_matches("0x")).unwrap_or_default();
    match dcap_qvl::verify::verify(&quote, &input.collateral, input.now_secs) {
        Ok(r) => println!("{{\"status\":\"{}\",\"advisories\":{}}}", r.status, r.advisory_ids.len()),
        Err(e) => println!("{{\"error\":\"{e:?}\"}}"),
    }
}
