//! TEST ONLY exact worker Json -> serde_json::to_string -> SHA256, never JCS in this helper.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{self, Read};
fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    let cases: Vec<Value> = serde_json::from_str(&input).unwrap();
    let rows: Vec<_> = cases.into_iter().map(|case| {
        let raw = case["body_bytes"].as_str().unwrap();
        let returned_value: Value = serde_json::from_str(raw).unwrap();
        // Exact upstream Json return-value path at 3079d756 worker/src/main.rs:3698-3717.
        let output = serde_json::to_string(&returned_value).unwrap();
        json!({"name":case["name"],"body_sha256":hex::encode(Sha256::digest(raw.as_bytes())),"output_sha256":hex::encode(Sha256::digest(output.as_bytes())),"equal":raw==output})
    }).collect();
    println!("{}", serde_json::to_string(&rows).unwrap());
}
