//! Codex audit A01. The pledge identity must ignore every Unicode Default_Ignorable_Code_Point,
//! including code points reserved for future ones, and case-equivalent spellings must stay one id.
//! The ranges come from the Unicode file in tests/fixtures, not from the engine's own table.
use truenav_v3_core::source::{
    document_root, fingerprint, is_default_ignorable, normalized_id, sha2_bytes, Fingerprinter,
    LoanTerms,
};
use truenav_v3_core::Result;

struct Mac;
impl Fingerprinter for Mac {
    fn mac(&self, message: &[u8]) -> Result<[u8; 32]> {
        Ok(sha2_bytes(message))
    }
}

fn fp(collateral: &str) -> String {
    let t = LoanTerms {
        version: "loan-terms-v2".into(),
        borrower_namespace: "demo".into(),
        borrower_id: "BORROWER".into(),
        origination_date: "2026-01-01".into(),
        principal_cents: "100".into(),
        currency: "USD".into(),
        collateral_namespace: "county-a".into(),
        collateral_ref: collateral.into(),
    };
    fingerprint(&t, "real_estate", &[], &Mac).unwrap()
}

/// Default_Ignorable_Code_Point ranges parsed from the Unicode 18.0.0 DerivedCoreProperties.txt lines.
fn unicode_ranges() -> Vec<(u32, u32)> {
    let src = include_str!("fixtures/unicode-18.0.0-default-ignorable.txt");
    assert!(src.contains("# DerivedCoreProperties-18.0.0.txt"));
    let mut out = Vec::new();
    for line in src
        .lines()
        .filter(|l| !l.starts_with('#') && !l.trim().is_empty())
    {
        let (range, rest) = line.split_once(';').expect("range ; property");
        assert!(rest
            .trim_start()
            .starts_with("Default_Ignorable_Code_Point"));
        let range = range.trim();
        let (a, b) = range.split_once("..").unwrap_or((range, range));
        out.push((
            u32::from_str_radix(a, 16).unwrap(),
            u32::from_str_radix(b, 16).unwrap(),
        ));
    }
    assert_eq!(out.len(), 27, "the Unicode 18.0.0 list has 27 lines");
    out
}

fn in_unicode_set(ranges: &[(u32, u32)], cp: u32) -> bool {
    ranges.iter().any(|(a, b)| (*a..=*b).contains(&cp))
}

#[test]
fn a01_every_unicode_default_ignorable_keeps_one_pledge_id() {
    let base = fp("PARCEL-1");
    let root = document_root("PARCEL-1").unwrap();
    let ranges = unicode_ranges();
    let mut count = 0;
    let mut forked = Vec::new();
    for (start, end) in &ranges {
        for cp in *start..=*end {
            let c = char::from_u32(cp).expect("no surrogates in the set");
            count += 1;
            for id in [
                format!("PARCEL{c}-1"),
                format!("{c}PARCEL-1"),
                format!("PARCEL-1{c}"),
            ] {
                if fp(&id) != base
                    || document_root(&id).unwrap() != root
                    || normalized_id(&id, true).unwrap() != "PARCEL-1"
                {
                    forked.push(format!("U+{cp:04X}"));
                    break;
                }
            }
        }
    }
    assert_eq!(
        count, 4174,
        "Unicode 18.0.0 has 4174 default-ignorable code points"
    );
    assert!(
        forked.is_empty(),
        "{} code points forked the pledge: {:?}",
        forked.len(),
        forked
    );
}

#[test]
fn a01_codex_repro_and_reserved_ranges_named() {
    let base = fp("PARCEL-1");
    for c in [
        '\u{180f}',
        '\u{2065}',
        '\u{fff0}',
        '\u{fff8}',
        '\u{e0000}',
        '\u{e0002}',
        '\u{e0080}',
        '\u{e01f0}',
        '\u{e0fff}',
    ] {
        assert_eq!(
            fp(&format!("PARCEL{c}-1")),
            base,
            "U+{:04X} forked the pledge",
            c as u32
        );
    }
}

/// An ignorable between a letter and its combining mark must not stop the pair composing.
#[test]
fn a01_ignorable_between_base_and_mark_keeps_one_id() {
    let plain = document_root("PARCE\u{301}L-1").unwrap();
    assert_eq!(document_root("PARC\u{c9}L-1").unwrap(), plain);
    for c in ['\u{180f}', '\u{200b}', '\u{e0001}', '\u{2065}'] {
        let id = format!("PARCE{c}\u{301}L-1");
        assert_eq!(
            document_root(&id).unwrap(),
            plain,
            "U+{:04X} split a composed letter",
            c as u32
        );
        assert_eq!(
            normalized_id(&id, true).unwrap(),
            normalized_id("PARCE\u{301}L-1", true).unwrap(),
            "U+{:04X} split a composed letter (case-sensitive)",
            c as u32
        );
    }
}

/// The engine table matches Unicode 18.0.0 exactly, plus two pre-A01 extras it keeps dropping:
/// interlinear annotation controls U+FFF9..U+FFFB and Egyptian hieroglyph format controls U+13430..U+13438.
#[test]
fn a01_engine_table_is_the_unicode_set() {
    let ranges = unicode_ranges();
    let mut diff = Vec::new();
    for cp in 0u32..=0x10FFFF {
        let Some(c) = char::from_u32(cp) else {
            continue;
        };
        let want = in_unicode_set(&ranges, cp)
            || (0xFFF9..=0xFFFB).contains(&cp)
            || (0x13430..=0x13438).contains(&cp);
        if is_default_ignorable(c) != want {
            diff.push(format!("U+{cp:04X}"));
        }
    }
    assert!(
        diff.is_empty(),
        "{} code points differ: {:?}",
        diff.len(),
        &diff[..diff.len().min(40)]
    );
}

/// Every character and its Unicode uppercase and lowercase forms give one document id.
#[test]
fn a01_case_equivalent_pairs_keep_identity() {
    let mut bad = Vec::new();
    for cp in 0u32..=0x10FFFF {
        let Some(c) = char::from_u32(cp) else {
            continue;
        };
        let root = |s: &str| document_root(&format!("A{s}B"));
        let one = root(&c.to_string());
        let upper: String = c.to_uppercase().collect();
        let lower: String = c.to_lowercase().collect();
        for v in [
            upper.clone(),
            lower.clone(),
            upper.to_lowercase(),
            lower.to_uppercase(),
        ] {
            if root(&v) != one {
                bad.push(format!("U+{cp:04X} vs {v:?}"));
                break;
            }
        }
    }
    assert!(
        bad.is_empty(),
        "{} case pairs forked: {:?}",
        bad.len(),
        &bad[..bad.len().min(40)]
    );
    for (a, b) in [
        ("PARCEL-1", "parcel-1"),
        ("ΡARCEL-1", "ρarcel-1"),
        ("ΕΧ-1", "εχ-1"),
        ("ΜΗ-1", "μη-1"),
        ("µ-1", "Μ-1"),
        ("ı-1", "I-1"),
        ("J\u{30c}-1", "\u{1f0}-1"),
        ("ᾈ-1", "ᾀ-1"),
        ("ΣΑΣ", "σας"),
        ("STRASSE", "straße"),
        ("İ-1", "i-1"),
    ] {
        assert_eq!(
            document_root(a).unwrap(),
            document_root(b).unwrap(),
            "{a} vs {b}"
        );
    }
}

/// The document id is a fixed point: normalizing twice changes nothing.
#[test]
fn a01_document_root_is_idempotent() {
    let mut bad = Vec::new();
    for cp in 0u32..=0x10FFFF {
        let Some(c) = char::from_u32(cp) else {
            continue;
        };
        let Ok(once) = document_root(&format!("A{c}B")) else {
            continue;
        };
        if document_root(&once).as_ref() != Ok(&once) {
            bad.push(format!("U+{cp:04X}"));
        }
    }
    assert!(
        bad.is_empty(),
        "{} not idempotent: {:?}",
        bad.len(),
        &bad[..bad.len().min(40)]
    );
}

/// ASCII ids, which is every id the live pledge module accepts, keep their exact pre-A01 values.
#[test]
fn a01_ascii_ids_unchanged() {
    assert_eq!(
        document_root("COLLATERAL HARBOR 0").unwrap(),
        "collateralharbor0"
    );
    assert_eq!(document_root("PARCEL-1").unwrap(), "parcel-1");
    assert_eq!(normalized_id("Parcel-1", true).unwrap(), "Parcel-1");
    assert_eq!(fp("PARCEL-1"), fp("parcel-1"), "ASCII casefold");
}

/// Every lookalike documented in source.rs (`latin_lookalike` and `lowercase_lookalike`) with its Latin
/// target. Kept as a plain list here so the test does not trust the engine's own table.
#[rustfmt::skip]
pub const DOCUMENTED_LOOKALIKES: &[(char, char)] = &[
    ('А', 'a'), ('а', 'a'), ('Α', 'a'), ('α', 'a'),
    ('В', 'b'), ('в', 'b'), ('Β', 'b'), ('β', 'b'),
    ('Е', 'e'), ('е', 'e'), ('Ε', 'e'), ('ε', 'e'),
    ('К', 'k'), ('к', 'k'), ('Κ', 'k'), ('κ', 'k'),
    ('М', 'm'), ('м', 'm'), ('Μ', 'm'), ('μ', 'm'),
    ('Н', 'h'), ('н', 'h'), ('Η', 'h'), ('η', 'h'),
    ('О', 'o'), ('о', 'o'), ('Ο', 'o'), ('ο', 'o'),
    ('Р', 'p'), ('р', 'p'), ('Ρ', 'p'), ('ρ', 'p'),
    ('С', 'c'), ('с', 'c'), ('Ϲ', 'c'), ('ϲ', 'c'),
    ('Т', 't'), ('т', 't'), ('Τ', 't'), ('τ', 't'),
    ('У', 'y'), ('у', 'y'),
    ('Х', 'x'), ('х', 'x'), ('Χ', 'x'), ('χ', 'x'),
    ('І', 'i'), ('і', 'i'), ('Ι', 'i'), ('ι', 'i'),
    ('Ј', 'j'), ('ј', 'j'),
    ('Ѕ', 's'), ('ѕ', 's'),
];

/// Codex audit A01 follow-up: `["c","\u{3f9}"]` kept two pledge ids because NFKC turned U+03F9 into
/// U+03A3 before the lookalike map ran. Every documented lookalike must give the same id as its Latin
/// letter, in either case, alone and inside a ref, and the same fingerprint.
#[test]
fn a01_every_documented_lookalike_keeps_one_pledge_id() {
    let mut bad = Vec::new();
    for &(l, t) in DOCUMENTED_LOOKALIKES {
        let upper = t.to_ascii_uppercase();
        for (a, b) in [
            (l.to_string(), t.to_string()),
            (format!("PARCEL-{l}-1"), format!("PARCEL-{t}-1")),
            (format!("PARCEL-{l}-1"), format!("PARCEL-{upper}-1")),
        ] {
            if document_root(&a) != document_root(&b) || fp(&a) != fp(&b) {
                bad.push(format!(
                    "U+{:04X} {a:?} -> {:?} vs {b:?} -> {:?}",
                    l as u32,
                    document_root(&a),
                    document_root(&b)
                ));
            }
        }
    }
    // Case-sensitive namespaces apply the same map except the lowercase-only Greek forms.
    for &(l, t) in DOCUMENTED_LOOKALIKES {
        if matches!(l, 'ε' | 'η' | 'μ' | 'ρ' | 'ϲ') {
            continue;
        }
        let (a, b) = (format!("Parcel-{l}-1"), format!("Parcel-{t}-1"));
        if normalized_id(&a, true) != normalized_id(&b, true) {
            bad.push(format!(
                "case-sensitive U+{:04X} {:?} vs {:?}",
                l as u32,
                normalized_id(&a, true),
                normalized_id(&b, true)
            ));
        }
    }
    assert!(
        bad.is_empty(),
        "{} lookalikes forked: {:#?}",
        bad.len(),
        bad
    );
}
