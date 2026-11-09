//! Red team round 1 repros. These assert the pledge identity the registry is supposed to enforce.
use truenav_v3_core::source::{fingerprint, normalized_id, sha2_bytes, Fingerprinter, LoanTerms};
use truenav_v3_core::Result;

struct Mac;
impl Fingerprinter for Mac {
    fn mac(&self, message: &[u8]) -> Result<[u8; 32]> {
        Ok(sha2_bytes(message))
    }
}

fn terms(borrower: &str, principal: &str, collateral: &str) -> LoanTerms {
    LoanTerms {
        version: "loan-terms-v2".into(),
        borrower_namespace: "demo".into(),
        borrower_id: borrower.into(),
        origination_date: "2026-01-01".into(),
        principal_cents: principal.into(),
        currency: "USD".into(),
        collateral_namespace: "demo".into(),
        collateral_ref: collateral.into(),
    }
}

#[test]
fn redteam_r1_unicode_space_and_case_must_not_fork_fingerprints() {
    let spaced = normalized_id("ACME CORP", false).unwrap();
    let nbsp = normalized_id("ACME\u{00a0}CORP", false).unwrap();
    assert_eq!(spaced, nbsp, "a unicode space forked the borrower id");
    let ideographic = normalized_id("ACME\u{3000}CORP", false).unwrap();
    assert_eq!(spaced, ideographic, "an ideographic space forked the borrower id");
    let lower = normalized_id("jose", false).unwrap();
    let accent = normalized_id("jos\u{00e9}", false).unwrap();
    let upper_accent = normalized_id("JOS\u{00c9}", false).unwrap();
    assert_eq!(accent, upper_accent, "non-ASCII case forked the borrower id");
    let _ = lower;
    let a = fingerprint(&terms("ACME CORP", "100", "UNIT-1"), &[], &Mac).unwrap();
    let b = fingerprint(&terms("ACME\u{00a0}CORP", "100", "UNIT-1"), &[], &Mac).unwrap();
    assert_eq!(a, b, "unicode whitespace minted a second pledge hash");
}

#[test]
fn redteam_r1_one_cent_and_split_must_keep_one_pledge_identity() {
    let whole = fingerprint(&terms("BORROWER", "200", "UNIT-1"), &[], &Mac).unwrap();
    let cent = fingerprint(&terms("BORROWER", "201", "UNIT-1"), &[], &Mac).unwrap();
    assert_eq!(whole, cent, "one cent of principal minted a second pledge hash");
    let left = fingerprint(&terms("BORROWER-A", "100", "UNIT-1"), &[], &Mac).unwrap();
    let right = fingerprint(&terms("BORROWER-B", "100", "UNIT-1"), &[], &Mac).unwrap();
    assert!(
        left == whole || right == whole,
        "splitting principal across two borrower ids escaped the original pledge"
    );
}

#[test]
fn redteam_r1_v1_document_fingerprint_and_v2_terms_must_collide() {
    let mac = Mac;
    let hex_of = |b: [u8; 32]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
    let canonical = truenav_v3_core::source::document_root("TITLE-1").unwrap();
    let v1 = hex_of(
        mac.mac(format!("truenav-fp-v1|real_estate|{canonical}").as_bytes())
            .unwrap(),
    );
    let v2 = fingerprint(&terms("BORROWER", "100", "TITLE-1"), &[], &mac).unwrap();
    let renamed = fingerprint(&terms("BORROWER", "100", "TITLE-1-COPY"), &[], &mac).unwrap();
    assert_eq!(
        v1, v2,
        "fingerprint scheme change lets the same loan be pledged twice"
    );
    assert_eq!(
        v1, renamed,
        "renaming the document id lets the same v1 loan be pledged twice"
    );
    let lookups = truenav_v3_core::source::pledge_lookup_hashes(
        &terms("OTHER", "999", "TITLE-1-COPY"),
        &[],
        &mac,
    )
    .unwrap();
    assert!(lookups.contains(&v1), "lookup must still see the v1 domain");
}
