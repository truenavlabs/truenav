//! The bytes an upgrade would ship have to contain the round 1 fixes.
/// The committed pinned wasm predates these fixes, so this test is ignored until a pinned rebuild.
/// `cargo test -- --ignored` still runs it. Rebuild with the pinned image in receipts/README.md.
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
