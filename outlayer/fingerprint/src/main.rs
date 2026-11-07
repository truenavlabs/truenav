//! TrueNav loan fingerprint (owner decision D1, 7 Nov): replaces the guessable demo fingerprint
//! sha256("truenav-demo-v1|" + asset + "|" + document id) with
//! HMAC-SHA256(key, "truenav-fp-v1|" + asset + "|" + document id), where the key is derived inside the
//! OutLayer TEE for this project and the calling account, never seen by the module, the operator or anyone else.
//! Same input, same caller, same project: same fingerprint, so a second fund's pledge of the same loan still
//! collides on chain. Runs over HTTPS only, so the document id never lands in public transaction data.
use serde::Deserialize;
use serde_json::json;
use std::io::{self, Read, Write};

mod host {
    wit_bindgen::generate!({ world: "guest", path: "wit", generate_all });
}
use host::outlayer::encryption_keys::api as keys;

// The manifest, in the `outlayer.manifest` custom section: covered by the wasm's sha256.
#[used]
#[link_section = "outlayer.manifest"]
static OUTLAYER_MANIFEST: [u8; include_bytes!("../manifest.json").len()] = *include_bytes!("../manifest.json");

const KEY: &str = "loan-fingerprint";
const DOMAIN: &str = "truenav-fp-v1";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    asset_type: String,
    document_id: String,
    /// Random, ignored by the MAC. The run's public attestation carries sha256(input); without a nonce that hash
    /// would be as guessable as the old demo fingerprint (spike finding, 7 Nov).
    nonce: String,
}

fn run() -> Result<serde_json::Value, String> {
    if std::env::var("OUTLAYER_EXECUTION_TYPE").as_deref() != Ok("HTTPS") {
        return Err("fingerprints are computed over HTTPS only: on chain the input would be public".into());
    }
    let mut raw = String::new();
    io::stdin().read_to_string(&mut raw).map_err(|e| e.to_string())?;
    let input: Input = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    if input.nonce.len() < 32 || !input.nonce.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("nonce must be at least 32 random hex characters".into());
    }
    if input.asset_type != "real_estate" && input.asset_type != "invoices" {
        return Err("asset_type must be real_estate or invoices".into());
    }
    if input.document_id.is_empty() || input.document_id.len() > 128 || input.document_id.contains('|') {
        return Err("document_id must be 1 to 128 characters without '|'".into());
    }
    let tag = keys::mac(KEY, None, format!("{DOMAIN}|{}|{}", input.asset_type, input.document_id).as_bytes())?;
    Ok(json!({ "loan_hash": hex::encode(tag), "domain": DOMAIN }))
}

fn main() {
    let answer = run().unwrap_or_else(|error| json!({ "error": error }));
    print!("{answer}");
    io::stdout().flush().expect("stdout");
}
