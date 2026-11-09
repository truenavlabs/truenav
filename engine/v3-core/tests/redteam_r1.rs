//! Red team round 1 repros. These assert the pledge identity the registry is supposed to enforce.
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

#[test]
fn redteam_r1_unicode_space_and_case_must_not_fork_fingerprints() {
    let spaced = normalized_id("ACME CORP", false).unwrap();
    let nbsp = normalized_id("ACME\u{00a0}CORP", false).unwrap();
    assert_eq!(spaced, nbsp, "a unicode space forked the borrower id");
    let ideographic = normalized_id("ACME\u{3000}CORP", false).unwrap();
    assert_eq!(
        spaced, ideographic,
        "an ideographic space forked the borrower id"
    );
    let lower = normalized_id("jose", false).unwrap();
    let accent = normalized_id("jos\u{00e9}", false).unwrap();
    let upper_accent = normalized_id("JOS\u{00c9}", false).unwrap();
    assert_eq!(
        accent, upper_accent,
        "non-ASCII case forked the borrower id"
    );
    let _ = lower;
    let a = fingerprint(
        &terms("demo", "ACME CORP", "100", "UNIT-1"),
        "real_estate",
        &[],
        &Mac,
    )
    .unwrap();
    let b = fingerprint(
        &terms("demo", "ACME\u{00a0}CORP", "100", "UNIT-1"),
        "real_estate",
        &[],
        &Mac,
    )
    .unwrap();
    assert_eq!(a, b, "unicode whitespace minted a second pledge hash");
}

#[test]
fn redteam_r1_one_cent_and_split_must_keep_one_pledge_identity() {
    let whole = fingerprint(
        &terms("demo", "BORROWER", "200", "UNIT-1"),
        "real_estate",
        &[],
        &Mac,
    )
    .unwrap();
    let cent = fingerprint(
        &terms("demo", "BORROWER", "201", "UNIT-1"),
        "real_estate",
        &[],
        &Mac,
    )
    .unwrap();
    assert_eq!(
        whole, cent,
        "one cent of principal minted a second pledge hash"
    );
    let left = fingerprint(
        &terms("demo", "BORROWER-A", "100", "UNIT-1"),
        "real_estate",
        &[],
        &Mac,
    )
    .unwrap();
    let right = fingerprint(
        &terms("demo", "BORROWER-B", "100", "UNIT-1"),
        "real_estate",
        &[],
        &Mac,
    )
    .unwrap();
    assert_eq!(
        left, whole,
        "a borrower rename inside the same external ref escaped the pledge"
    );
    assert_eq!(
        right, whole,
        "a second borrower id inside the same external ref escaped the pledge"
    );
}

#[test]
fn redteam_r1_v1_document_fingerprint_and_v2_terms_must_collide() {
    let mac = Mac;
    let anchored = |ns: &str, doc: &str, borrower: &str| {
        fingerprint(&terms(ns, borrower, "100", doc), "real_estate", &[], &mac).unwrap()
    };
    let external = anchored("county-a", "PARCEL-1", "BORROWER");
    let renamed = anchored("county-a", "PARCEL-1", "BORROWER-RENAMED");
    assert_eq!(
        external, renamed,
        "a rename inside the same external ref must stay one pledge"
    );
    let copy_suffix = anchored("county-a", "PARCEL-1-COPY", "BORROWER");
    assert_ne!(
        external, copy_suffix,
        "a different ref is a different external identifier"
    );
    let other_ns = anchored("county-b", "PARCEL-1", "BORROWER");
    assert_ne!(
        external, other_ns,
        "another namespace is not this collateral"
    );
    let doc = document_root("PARCEL-1").unwrap();
    let mut framed = Vec::new();
    truenav_v3_core::source::lp(&mut framed, b"truenav-fp-v1").unwrap();
    truenav_v3_core::source::lp(&mut framed, b"real_estate").unwrap();
    truenav_v3_core::source::lp(&mut framed, b"county-a").unwrap();
    truenav_v3_core::source::lp(&mut framed, doc.as_bytes()).unwrap();
    let legacy = mac
        .mac(&framed)
        .unwrap()
        .iter()
        .map(|x| format!("{x:02x}"))
        .collect::<String>();
    let lookups = pledge_lookup_hashes(
        &terms("county-a", "OTHER", "999", "PARCEL-1"),
        "real_estate",
        &[],
        &mac,
    )
    .unwrap();
    assert_eq!(
        lookups[0], external,
        "lookup must lead with the v4 identity"
    );
    assert!(
        !lookups.contains(&legacy),
        "the v1 alias was removed: a local hash cannot match a historical lock"
    );
    assert_eq!(lookups.len(), 1);
    let invoices = pledge_lookup_hashes(
        &terms("county-a", "OTHER", "999", "PARCEL-1"),
        "invoices",
        &[],
        &mac,
    )
    .unwrap();
    assert!(
        !invoices.contains(&legacy),
        "another asset class must not reuse this alias"
    );
    assert_ne!(invoices[0], external);
    let other_namespace = pledge_lookup_hashes(
        &terms("county-b", "OTHER", "999", "PARCEL-1"),
        "real_estate",
        &[],
        &mac,
    )
    .unwrap();
    assert_ne!(
        other_namespace[0], external,
        "the same ref in another namespace is not this loan"
    );
}
