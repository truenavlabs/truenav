//! Round 1b. These assert the pledge identity that should hold after the v4 fix.
use truenav_v3_core::source::{
    document_root, fingerprint, normalized_id, pledge_lookup_hashes, sha2_bytes, Fingerprinter,
    LoanTerms,
};
use truenav_v3_core::Result;

struct Mac;
impl Fingerprinter for Mac {
    fn mac(&self, message: &[u8]) -> Result<[u8; 32]> {
        Ok(sha2_bytes(message))
    }
}

fn terms(ns: &str, borrower: &str, principal: &str, collateral: &str) -> LoanTerms {
    LoanTerms {
        version: "loan-terms-v2".into(),
        borrower_namespace: "demo".into(),
        borrower_id: borrower.into(),
        origination_date: "2026-01-01".into(),
        principal_cents: principal.into(),
        currency: "USD".into(),
        collateral_namespace: ns.into(),
        collateral_ref: collateral.into(),
    }
}

fn fp(collateral: &str) -> String {
    fingerprint(
        &terms("county-a", "BORROWER", "100", collateral),
        "real_estate",
        &[],
        &Mac,
    )
    .unwrap()
}

#[test]
fn redteam_r1b_zero_width_and_fullwidth_stay_one_pledge() {
    let base = fp("PARCEL-1");
    assert_eq!(fp("PARCEL\u{200b}-1"), base, "ZWSP forked the pledge");
    assert_eq!(fp("PARCEL\u{feff}-1"), base, "BOM forked the pledge");
    assert_eq!(
        fp("PARCEL\u{00ad}-1"),
        base,
        "soft hyphen forked the pledge"
    );
    assert_eq!(fp("\u{ff30}ARCEL-1"), base, "fullwidth P forked the pledge");
    assert_eq!(
        document_root("PARCEL-1").unwrap(),
        document_root("parcel-1").unwrap()
    );
}

#[test]
fn redteam_r1b_variation_selector_must_not_fork_the_pledge() {
    let base = fp("PARCEL-1");
    assert_eq!(
        fp("PARCEL-1\u{fe0f}"),
        base,
        "U+FE0F variation selector forked the pledge"
    );
}

#[test]
fn redteam_r1b_tag_characters_must_not_fork_the_pledge() {
    let base = fp("PARCEL-1");
    assert_eq!(
        fp("PARCEL-1\u{e007f}"),
        base,
        "U+E007F tag character forked the pledge"
    );
    assert_eq!(
        fp("PARCEL\u{180b}-1"),
        base,
        "U+180B mongolian variation selector forked the pledge"
    );
}

#[test]
fn redteam_r1b_confusable_homoglyph_must_not_fork_the_pledge() {
    let base = fp("PARCEL-1");
    let cyrillic_er = format!("\u{0420}ARCEL-1");
    assert_eq!(
        fp(&cyrillic_er),
        base,
        "a cyrillic homoglyph forked the pledge"
    );
}

#[test]
fn redteam_r1b_unicode_casefold_must_not_fork_the_pledge() {
    let sigma = normalized_id("Σ", false).unwrap();
    let final_sigma = normalized_id("ς", false).unwrap();
    assert_eq!(sigma, final_sigma, "final sigma casefold forked the id");
    let ss = normalized_id("SS", false).unwrap();
    let eszett = normalized_id("ß", false).unwrap();
    assert_eq!(ss, eszett, "eszett casefold forked the id");
    let dotted = normalized_id("İ", false).unwrap();
    let ascii_i = normalized_id("I", false).unwrap();
    assert_eq!(dotted, ascii_i, "turkish I casefold forked the id");
}

#[test]
fn redteam_r1b_v4_length_prefix_must_not_collide() {
    let a = fingerprint(&terms("county-a", "B", "1", "b|c"), "a", &[], &Mac).unwrap();
    let b = fingerprint(&terms("county-a", "B", "1", "c"), "a|b", &[], &Mac).unwrap();
    assert_ne!(a, b, "length prefix collided across asset and document");
}

#[test]
fn redteam_r1b_legacy_alias_must_not_collide_across_loans() {
    let left = pledge_lookup_hashes(&terms("county-a", "B", "1", "c"), "a|b", &[], &Mac).unwrap();
    let right = pledge_lookup_hashes(&terms("county-a", "B", "1", "b|c"), "a", &[], &Mac).unwrap();
    assert_ne!(
        left[1], right[1],
        "the v1 alias string collided for two different loans"
    );
}

#[test]
fn redteam_r1b_migration_alias_must_match_the_pledge_module_message() {
    // The original repro compared an uppercase v1 pipe string with the lowercased alias.
    // That expectation fights casefold: PARCEL-1 and parcel-1 are one document.
    // Both producers now MAC the same v4 preimage, and the alias is length-prefixed.
    let module_src = include_str!("../../../outlayer/fingerprint/src/main.rs");
    assert!(
        module_src.contains("pledge_frame"),
        "the pledge module does not use the shared v4 preimage"
    );
    let direct =
        truenav_v3_core::source::pledge_message("real_estate", "county-a", "PARCEL-1").unwrap();
    let folded =
        truenav_v3_core::source::pledge_message("real_estate", "county-a", "parcel-1").unwrap();
    assert_eq!(direct, folded, "case still forks the shared preimage");
    let mut layout = Vec::new();
    for part in [
        b"truenav-fp-v4".as_slice(),
        b"real_estate",
        b"county-a",
        b"parcel-1",
    ] {
        truenav_v3_core::source::lp(&mut layout, part).unwrap();
    }
    assert_eq!(
        direct, layout,
        "engine preimage drifted from the pledge module layout"
    );
    let alias = pledge_lookup_hashes(
        &terms("county-a", "B", "1", "PARCEL-1"),
        "real_estate",
        &[],
        &Mac,
    )
    .unwrap();
    let primary = hex_mac(&direct);
    assert_eq!(
        alias[0], primary,
        "lookup index 0 is not the shared v4 message"
    );
}

fn hex_mac(message: &[u8]) -> String {
    Mac.mac(message)
        .unwrap()
        .iter()
        .map(|x| format!("{x:02x}"))
        .collect()
}

#[test]
fn redteam_r1b_pledge_module_and_engine_must_share_one_mac_key() {
    let module_src = include_str!("../../../outlayer/fingerprint/src/main.rs");
    let engine_src = include_str!("../../../outlayer/engine-v3/src/main.rs");
    let module_key = module_src.contains("const KEY: &str = \"loan-fingerprint\"");
    let engine_key = engine_src.contains("keys::mac(\"loan-terms-v2\"");
    assert!(
        !(module_key && engine_key),
        "pledge creation and the NAV check use different MAC key paths"
    );
}

#[test]
fn redteam_r1b_default_ignorable_class_does_not_fork_the_pledge() {
    let base = fp("PARCEL-1");
    let ranges: &[(u32, u32)] = &[
        (0x00AD, 0x00AD),
        (0x034F, 0x034F),
        (0x061C, 0x061C),
        (0x115F, 0x1160),
        (0x17B4, 0x17B5),
        (0x180B, 0x180E),
        (0x200B, 0x200F),
        (0x202A, 0x202E),
        (0x2060, 0x2064),
        (0x2066, 0x206F),
        (0x3164, 0x3164),
        (0xFE00, 0xFE0F),
        (0xFEFF, 0xFEFF),
        (0xFFA0, 0xFFA0),
        (0xFFF9, 0xFFFB),
        (0x13430, 0x13438),
        (0x1BCA0, 0x1BCA3),
        (0x1D173, 0x1D17A),
        (0xE0001, 0xE0001),
        (0xE0020, 0xE007F),
        (0xE0100, 0xE01EF),
    ];
    for (start, end) in ranges {
        for cp in *start..=*end {
            let Some(c) = char::from_u32(cp) else {
                continue;
            };
            assert!(
                truenav_v3_core::source::is_default_ignorable(c),
                "U+{cp:04X} is outside the ignorable class"
            );
            let id = format!("PARCEL{c}-1");
            assert_eq!(fp(&id), base, "U+{cp:04X} forked the pledge");
        }
    }
}
