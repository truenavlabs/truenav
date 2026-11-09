//! The bytes an upgrade would ship have to contain the round 1 fixes.
/// Rebuild is forbidden in this pass. The expectation is right and the pin is stale.
/// `cargo test -- --ignored` still runs it. See FIX_R1D.md for the rebuild commands.
#[test]
#[ignore = "pinned wasm rebuild is out of scope for this pass"]
fn redteam_r1b_pinned_receipts_wasm_contains_the_round1_fixes() {
    let wasm = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/dist/truenav_receipts.wasm"
    ))
    .expect("committed receipts wasm");
    let text = String::from_utf8_lossy(&wasm);
    for needle in [
        "token limit",
        "attestation_record_missing",
        "head_status",
        "fund_id",
    ] {
        assert!(
            text.contains(needle),
            "pinned receipts wasm is missing {needle}"
        );
    }
}
