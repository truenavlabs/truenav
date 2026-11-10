//! Pure input and output rules of the TrueNav fingerprint module, kept apart from the OutLayer host bindings so they
//! are unit-tested on the native target (`cargo test`). Owner decision 7 Nov (AUDIT_FINDINGS 25, 26).

mod keccak;

pub use keccak::keccak256;

/// Domain of a pledge ticket. Same text the registry contract builds in `pledge_message`.
pub const PLEDGE_DOMAIN: &str = "truenav-pledge-v1";

/// Fields the module itself puts into a pledge ticket. There is no field for a caller-supplied digest or signature.
#[derive(Clone, Debug, PartialEq)]
pub struct TicketRequest {
    pub contract_id: String,
    pub network: String,
    pub fund_account: String,
    pub expiry_ms: u64,
    pub pledge_nonce: String,
}

fn no_pipe(label: &str, value: &str) -> Result<(), String> {
    if value.is_empty() || value.contains('|') {
        return Err(format!("{label} must be non-empty and must not contain '|'"));
    }
    Ok(())
}

/// Canonical ticket text. The loan hash is the fingerprint this module just computed, not a caller-supplied digest.
pub fn pledge_ticket_message(loan_hash: &str, asset_type: &str, ticket: &TicketRequest) -> Result<String, String> {
    if loan_hash.len() != 64 || !loan_hash.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
        return Err("loan_hash must be 64 lowercase hex characters".into());
    }
    if asset_type != "real_estate" && asset_type != "invoices" {
        return Err("asset_type must be real_estate or invoices".into());
    }
    no_pipe("contract_id", &ticket.contract_id)?;
    no_pipe("network", &ticket.network)?;
    no_pipe("fund_account", &ticket.fund_account)?;
    if ticket.pledge_nonce.len() < 32
        || ticket.pledge_nonce.len() > 64
        || !ticket.pledge_nonce.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err("pledge_nonce must be 32 to 64 lowercase hex characters".into());
    }
    Ok(format!(
        "{PLEDGE_DOMAIN}|{}|{}|{loan_hash}|{}|{asset_type}|{}|{}",
        ticket.contract_id, ticket.network, ticket.fund_account, ticket.pledge_nonce, ticket.expiry_ms
    ))
}

/// EIP-191 digest of a message this module composed. `sign` is given only this 32-byte digest.
pub fn eip191_prehash(message: &str) -> [u8; 32] {
    let prefix = format!("\u{19}Ethereum Signed Message:\n{}", message.len());
    let mut data = prefix.into_bytes();
    data.extend_from_slice(message.as_bytes());
    keccak256(&data)
}

/// Compose the ticket and ask `sign` for a 65-byte r || s || v. `sign` is never given caller bytes.
pub fn compose_ticket<F>(loan_hash: &str, asset_type: &str, ticket: &TicketRequest, mut sign: F) -> Result<(String, String), String>
where
    F: FnMut(&[u8; 32]) -> Result<Vec<u8>, String>,
{
    let message = pledge_ticket_message(loan_hash, asset_type, ticket)?;
    let digest = eip191_prehash(&message);
    let sig = sign(&digest)?;
    if sig.len() != 65 {
        return Err(format!("ticket signature must be 65 bytes, got {}", sig.len()));
    }
    Ok((message, format!("0x{}", hex::encode(sig))))
}

/// Longest document id accepted (characters, all ASCII).
pub const MAX_ID_LEN: usize = 128;

/// A document id is canonical when it matches `^[A-Z0-9][A-Z0-9-]{0,127}$`: uppercase A to Z, digits and hyphens,
/// 1 to 128 characters, not starting with a hyphen. The same rule as `isCanonicalId` in tee/fingerprint.mjs. Any
/// other id is refused, never rewritten, so two spellings of one id can never reach the MAC (finding 25).
pub fn is_canonical_id(id: &str) -> bool {
    let b = id.as_bytes();
    !b.is_empty()
        && b.len() <= MAX_ID_LEN
        && (b[0].is_ascii_uppercase() || b[0].is_ascii_digit())
        && b.iter()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || *c == b'-')
}

/// v4 pledge preimage. Same layout as `truenav_v3_core::source::pledge_message`.
/// `case_sensitive` false lowercases the namespace and the document, which is the default policy.
/// `case_sensitive` true keeps both as given, matching `fingerprint` when that namespace is listed.
pub fn pledge_frame(asset_type: &str, collateral_namespace: &str, document_id: &str) -> Vec<u8> {
    pledge_frame_with(asset_type, collateral_namespace, document_id, false)
}

pub fn pledge_frame_with(
    asset_type: &str,
    collateral_namespace: &str,
    document_id: &str,
    case_sensitive: bool,
) -> Vec<u8> {
    fn lp(out: &mut Vec<u8>, bytes: &[u8]) {
        let n = u32::try_from(bytes.len()).expect("framing size");
        out.extend_from_slice(&n.to_be_bytes());
        out.extend_from_slice(bytes);
    }
    let asset = asset_type.to_ascii_lowercase();
    let ns = if case_sensitive {
        collateral_namespace.to_string()
    } else {
        collateral_namespace.to_ascii_lowercase()
    };
    let doc = if case_sensitive {
        document_id.to_string()
    } else {
        document_id.to_ascii_lowercase()
    };
    let mut framed = Vec::new();
    lp(&mut framed, b"truenav-fp-v4");
    lp(&mut framed, asset.as_bytes());
    lp(&mut framed, ns.as_bytes());
    lp(&mut framed, doc.as_bytes());
    framed
}

/// Mixed-case ASCII id used when a namespace is case-sensitive. Uppercase-only ids stay on `is_canonical_id`.
pub fn is_mixed_case_id(id: &str) -> bool {
    let b = id.as_bytes();
    !b.is_empty()
        && b.len() <= MAX_ID_LEN
        && (b[0].is_ascii_alphanumeric())
        && b.iter()
            .all(|c| c.is_ascii_alphanumeric() || *c == b'-')
}

/// The host's MAC must be exactly 32 bytes (HMAC-SHA256); anything else is refused before hex encoding (finding 26).
pub fn tag_hex(tag: &[u8]) -> Result<String, String> {
    if tag.len() != 32 {
        return Err(format!("MAC output must be 32 bytes, got {}", tag.len()));
    }
    Ok(hex::encode(tag))
}

#[cfg(test)]
mod tests {
    use super::*;

    // The same lists as tee/test/fingerprint.test.mjs ("only canonical document ids are accepted").
    #[test]
    fn canonical_ids_are_accepted() {
        for ok in ["TITLE-DEMO-HRE01", "INV-123", "A"] {
            assert!(is_canonical_id(ok), "{ok}");
        }
        assert!(is_canonical_id(&"X".repeat(MAX_ID_LEN)));
    }

    #[test]
    fn non_canonical_ids_are_refused() {
        let long = "X".repeat(MAX_ID_LEN + 1);
        for bad in [
            " INV-123",
            "inv-123",
            "INV 123",
            "INV|1",
            "",
            "-INV",
            long.as_str(),
        ] {
            assert!(!is_canonical_id(bad), "{bad:?}");
        }
        // Lookalikes that a lenient check might let through.
        for bad in [
            "INV-123 ",
            "INV\t123",
            "INV_123",
            "ÍNV-1",
            "INV\u{2010}1",
            "INV-1\n",
        ] {
            assert!(!is_canonical_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn pledge_frame_matches_pledge_message_for_every_recorded_fixture() {
        let raw = include_str!("../../../tee/fixtures/fingerprints.json");
        let v: serde_json::Value = serde_json::from_str(raw).unwrap();
        for rec in v["records"].as_array().unwrap() {
            let asset = rec["asset_type"].as_str().unwrap();
            let doc = rec["document_id"].as_str().unwrap();
            for ns in ["demo", "county-a", "county-b"] {
                let msg = truenav_v3_core::source::pledge_message(asset, ns, doc).unwrap();
                assert_eq!(pledge_frame(asset, ns, doc), msg, "{asset} {ns} {doc}");
            }
        }
    }

    #[test]
    fn pledge_frame_matches_the_engine_v4_layout() {
        let frame = pledge_frame("real_estate", "county-a", "PARCEL-1");
        let mut expect = Vec::new();
        for part in [
            b"truenav-fp-v4".as_slice(),
            b"real_estate",
            b"county-a",
            b"parcel-1",
        ] {
            expect.extend_from_slice(&(part.len() as u32).to_be_bytes());
            expect.extend_from_slice(part);
        }
        assert_eq!(frame, expect);
        assert!(!frame.windows(8).any(|w| w == b"PARCEL-1"));
    }

    #[test]
    fn mixed_case_producer_hash_matches_the_engine_lookup() {
        use truenav_v3_core::source::{
            fingerprint, pledge_lookup_hashes, sha2_bytes, Fingerprinter, LoanTerms,
        };
        struct Mac;
        impl Fingerprinter for Mac {
            fn mac(&self, message: &[u8]) -> truenav_v3_core::Result<[u8; 32]> {
                Ok(sha2_bytes(message))
            }
        }
        let terms = LoanTerms {
            version: "loan-terms-v2".into(),
            borrower_namespace: "demo".into(),
            borrower_id: "B1".into(),
            origination_date: "2026-01-01".into(),
            principal_cents: "100".into(),
            currency: "USD".into(),
            collateral_namespace: "Deeds".into(),
            collateral_ref: "Ab-1".into(),
        };
        let policy = vec!["Deeds".to_string()];
        let frame = pledge_frame_with("real_estate", "Deeds", "Ab-1", true);
        let produced = Mac.mac(&frame).unwrap();
        let produced_hex = produced.iter().map(|b| format!("{b:02x}")).collect::<String>();
        let looked = pledge_lookup_hashes(&terms, "real_estate", &policy, &Mac).unwrap();
        assert_eq!(looked.len(), 1);
        assert_eq!(looked[0], produced_hex, "producer frame is not the engine lookup");
        let via_fingerprint = fingerprint(&terms, "real_estate", &policy, &Mac).unwrap();
        assert_eq!(via_fingerprint, produced_hex);
        let other = fingerprint(
            &LoanTerms {
                collateral_ref: "aB-1".into(),
                ..terms
            },
            "real_estate",
            &policy,
            &Mac,
        )
        .unwrap();
        assert_ne!(other, produced_hex, "mixed-case refs collapsed");
    }

    #[test]
    fn only_a_32_byte_mac_is_encoded() {
        assert_eq!(tag_hex(&[0xab; 32]).unwrap(), "ab".repeat(32));
        for n in [0, 16, 31, 33, 64] {
            assert!(tag_hex(&vec![0u8; n]).is_err(), "{n} bytes");
        }
    }

    #[test]
    fn keccak256_of_empty_is_the_ethereum_vector() {
        assert_eq!(hex::encode(keccak256(b"")), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    }

    #[test]
    fn ticket_signs_only_the_digest_of_the_composed_tuple() {
        let ticket = TicketRequest {
            contract_id: "registry.test.near".into(),
            network: "mainnet".into(),
            fund_account: "harbor.testnet".into(),
            expiry_ms: 1000,
            pledge_nonce: "ab".repeat(32),
        };
        let loan = "11".repeat(32);
        let message = pledge_ticket_message(&loan, "real_estate", &ticket).unwrap();
        assert_eq!(
            message,
            format!("truenav-pledge-v1|registry.test.near|mainnet|{loan}|harbor.testnet|real_estate|{}|1000", "ab".repeat(32))
        );
        let mut seen = None;
        let (got, sig) = compose_ticket(&loan, "real_estate", &ticket, |d| {
            seen = Some(*d);
            Ok(vec![0x11; 65])
        })
        .unwrap();
        assert_eq!(got, message);
        assert_eq!(seen.unwrap(), eip191_prehash(&message));
        assert_eq!(sig, format!("0x{}", "11".repeat(65)));
        let mut bad = ticket.clone();
        bad.pledge_nonce = "TITLE-DEMO-HRE01".into();
        assert!(pledge_ticket_message(&loan, "real_estate", &bad).is_err());
    }
}
