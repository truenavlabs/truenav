//! TrueNav loan fingerprint (owner decision D1, 7 Nov): HMAC under key path `loan-terms-v2`
//! of the length-prefixed `truenav-fp-v4` preimage (asset class, collateral namespace, document id).
//! The key is the same derivation the NAV engine uses: project `receipts.../truenav-engine`,
//! bind `project`, caller `predecessor`, account the receipts contract, path `loan-terms-v2`.
//! Deploy this wasm as a version of that project and call it with a payment key the receipts
//! account owns. Over HTTPS the predecessor is that payment key's owner. A fund's key is a
//! different derivation. The module never sees the key.
//! Same input, same caller, same project: same fingerprint, so a second fund's pledge of the same loan still
//! collides on chain. Runs over HTTPS only, so the document id never lands in public transaction data.
//! When the input includes `ticket`, the module composes `truenav-pledge-v1` from the fingerprint it just
//! computed and signs that digest with manifest key `pledge-ticket`. It does not sign caller-supplied bytes.
use serde::Deserialize;
use serde_json::json;
use std::io::{self, Read, Write};
use truenav_fingerprint::{compose_ticket, is_canonical_id, tag_hex, TicketRequest};

mod host {
    wit_bindgen::generate!({ world: "guest", path: "wit", generate_all });
}
use host::outlayer::encryption_keys::api as keys;
use host::outlayer::signing_keys::api as signing;

// The manifest, in the `outlayer.manifest` custom section: covered by the wasm's sha256.
#[used]
#[link_section = "outlayer.manifest"]
static OUTLAYER_MANIFEST: [u8; include_bytes!("../manifest.json").len()] =
    *include_bytes!("../manifest.json");

const KEY: &str = "loan-terms-v2";
const TICKET_KEY: &str = "pledge-ticket";
const DOMAIN: &str = "truenav-fp-v4";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    asset_type: String,
    collateral_namespace: String,
    document_id: String,
    /// Random, ignored by the MAC. The run's public attestation carries sha256(input); without a nonce that hash
    /// would be as guessable as the old demo fingerprint (spike finding, 7 Nov).
    nonce: String,
    /// When true, namespace and document keep their case, matching a case-sensitive engine namespace.
    #[serde(default)]
    case_sensitive: bool,
    /// When present, the module composes a pledge ticket over the fingerprint it just computed and signs that
    /// text with the manifest key `pledge-ticket`. Caller-supplied digests and signatures are not a field of
    /// this input (`deny_unknown_fields`), so they are rejected.
    #[serde(default)]
    ticket: Option<TicketIn>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TicketIn {
    contract_id: String,
    network: String,
    fund_account: String,
    expiry_ms: u64,
    pledge_nonce: String,
}

fn run() -> Result<serde_json::Value, String> {
    if std::env::var("OUTLAYER_EXECUTION_TYPE").as_deref() != Ok("HTTPS") {
        return Err(
            "fingerprints are computed over HTTPS only: on chain the input would be public".into(),
        );
    }
    let mut raw = String::new();
    io::stdin()
        .read_to_string(&mut raw)
        .map_err(|e| e.to_string())?;
    let input: Input = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    if input.nonce.len() < 32 || !input.nonce.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("nonce must be at least 32 random hex characters".into());
    }
    if input.asset_type != "real_estate" && input.asset_type != "invoices" {
        return Err("asset_type must be real_estate or invoices".into());
    }
    // Canonical ids only (uppercase A to Z, digits, hyphen, 1 to 128 characters): refused, never rewritten, so two
    // spellings of one loan can never get two fingerprints (AUDIT_FINDINGS 25). This also rules out '|'.
    if input.case_sensitive {
        if !truenav_fingerprint::is_mixed_case_id(&input.collateral_namespace)
            || !truenav_fingerprint::is_mixed_case_id(&input.document_id)
        {
            return Err(
                "case-sensitive namespace and document must be ASCII letters, digits and hyphens"
                    .into(),
            );
        }
    } else if !is_canonical_id(&input.document_id) {
        return Err("document_id must be canonical: uppercase A to Z, digits and hyphens, 1 to 128 characters".into());
    }
    let message = truenav_fingerprint::pledge_frame_with(
        &input.asset_type,
        &input.collateral_namespace,
        &input.document_id,
        input.case_sensitive,
    );
    let tag = keys::mac(KEY, None, &message)?;
    // Exactly 32 bytes of HMAC-SHA256, or the run fails (AUDIT_FINDINGS 26).
    let loan_hash = tag_hex(&tag)?;
    let Some(ticket) = input.ticket else {
        return Ok(json!({ "loan_hash": loan_hash, "domain": DOMAIN }));
    };
    let request = TicketRequest {
        contract_id: ticket.contract_id,
        network: ticket.network,
        fund_account: ticket.fund_account,
        expiry_ms: ticket.expiry_ms,
        pledge_nonce: ticket.pledge_nonce,
    };
    // The host is asked to sign the 32-byte digest of the text this module composed. Not caller bytes.
    let (message, signature) = compose_ticket(&loan_hash, &input.asset_type, &request, |digest| signing::sign(TICKET_KEY, digest))?;
    Ok(json!({
        "loan_hash": loan_hash,
        "domain": DOMAIN,
        "ticket": {
            "domain": truenav_fingerprint::PLEDGE_DOMAIN,
            "message": message,
            "signature": signature,
            "key_path": TICKET_KEY,
            "note": "signed by the manifest secp256k1 key pledge-ticket. This module does not check attestation evidence."
        }
    }))
}

fn main() {
    let answer = run().unwrap_or_else(|error| json!({ "error": error }));
    print!("{answer}");
    io::stdout().flush().expect("stdout");
}
