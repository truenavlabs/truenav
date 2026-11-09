//! Pure input and output rules of the TrueNav fingerprint module, kept apart from the OutLayer host bindings so they
//! are unit-tested on the native target (`cargo test`). Owner decision 7 Nov (AUDIT_FINDINGS 25, 26).

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

/// v4 pledge preimage for a canonical document id. Same layout as `truenav_v3_core::source::pledge_message`
/// when the asset and namespace are already lowercase and the document is ASCII: length-prefixed
/// `truenav-fp-v4`, asset, namespace, and the lowercased document. The NAV check MACs these bytes
/// under key path `loan-terms-v2`.
pub fn pledge_frame(asset_type: &str, collateral_namespace: &str, document_id: &str) -> Vec<u8> {
    fn lp(out: &mut Vec<u8>, bytes: &[u8]) {
        let n = u32::try_from(bytes.len()).expect("framing size");
        out.extend_from_slice(&n.to_be_bytes());
        out.extend_from_slice(bytes);
    }
    let doc = document_id.to_ascii_lowercase();
    let asset = asset_type.to_ascii_lowercase();
    let ns = collateral_namespace.to_ascii_lowercase();
    let mut framed = Vec::new();
    lp(&mut framed, b"truenav-fp-v4");
    lp(&mut framed, asset.as_bytes());
    lp(&mut framed, ns.as_bytes());
    lp(&mut framed, doc.as_bytes());
    framed
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
    fn only_a_32_byte_mac_is_encoded() {
        assert_eq!(tag_hex(&[0xab; 32]).unwrap(), "ab".repeat(32));
        for n in [0, 16, 31, 33, 64] {
            assert!(tag_hex(&vec![0u8; n]).is_err(), "{n} bytes");
        }
    }
}
