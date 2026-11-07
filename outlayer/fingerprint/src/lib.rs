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
        && b.iter().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || *c == b'-')
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
        for bad in [" INV-123", "inv-123", "INV 123", "INV|1", "", "-INV", long.as_str()] {
            assert!(!is_canonical_id(bad), "{bad:?}");
        }
        // Lookalikes that a lenient check might let through.
        for bad in ["INV-123 ", "INV\t123", "INV_123", "ÍNV-1", "INV\u{2010}1", "INV-1\n"] {
            assert!(!is_canonical_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn only_a_32_byte_mac_is_encoded() {
        assert_eq!(tag_hex(&[0xab; 32]).unwrap(), "ab".repeat(32));
        for n in [0, 16, 31, 33, 64] {
            assert!(tag_hex(&vec![0u8; n]).is_err(), "{n} bytes");
        }
    }
}
