//! OutLayer TEE entry point for TrueNav cashflow-v2.0.0 (wasm32-wasip2). Reads the public input from stdin
//! ({"token_id", "run_nonce"} plus optional "as_of", "previous", "new_period"), fetches the bank feed, the manager
//! export and the issuer claims itself over HTTPS with a sealed read-only token, and prints the aggregate-only
//! receipt (src/tee.rs). Secrets (OutLayer env, sealed and build-locked):
//!   TRUENAV_DATA_URL    https base URL of the (mock) bank-data API
//!   TRUENAV_DATA_TOKEN  read-only bearer token for that API
//! Pseudonyms use OutLayer's per-project derived key (encryption-keys `mac`, path "truenav-ref"), never a known key.
#[cfg(target_arch = "wasm32")]
mod host {
    wit_bindgen::generate!({ world: "guest", path: "wit", generate_all });
}

// The manifest, in the `outlayer.manifest` custom section: covered by the wasm's sha256.
#[cfg(target_arch = "wasm32")]
#[used]
#[link_section = "outlayer.manifest"]
static OUTLAYER_MANIFEST: [u8; include_bytes!("../manifest.json").len()] = *include_bytes!("../manifest.json");

#[cfg(target_arch = "wasm32")]
mod tee_io {
    use super::host::outlayer::encryption_keys::api as keys;
    use std::time::Duration;
    use truenav_engine_v2::base::{Pseudonymizer, R};
    use truenav_engine_v2::tee::{Fetched, Fetcher};

    pub struct HostMac;
    impl Pseudonymizer for HostMac {
        fn mac32(&self, msg: &[u8]) -> R<Vec<u8>> {
            keys::mac("truenav-ref", None, msg)
        }
    }

    pub struct Https {
        pub base: String,
        pub token: String,
    }
    impl Fetcher for Https {
        fn get(&self, token_id: &str, doc: &str) -> Result<Fetched, String> {
            let url = format!("{}/v1/tokens/{}/{}", self.base.trim_end_matches('/'), token_id, doc);
            let resp = wasi_http_client::Client::new()
                .get(&url)
                .header("Authorization", format!("Bearer {}", self.token).as_str())
                .connect_timeout(Duration::from_secs(10))
                .send()
                .map_err(|_| "request".to_string())?;
            if resp.status() != 200 {
                return Err("status".into());
            }
            let synthetic = resp.headers().iter().any(|(k, v)| k.eq_ignore_ascii_case("x-synthetic-data") && v == "true");
            Ok(Fetched { body: resp.body().map_err(|_| "body".to_string())?, synthetic })
        }
    }
}

#[cfg(target_arch = "wasm32")]
fn main() {
    use std::io::{Read, Write};
    use truenav_engine_v2::tee::{execute, iso_from_unix, Clock};
    let mut input = String::new();
    let out = if std::io::stdin().read_to_string(&mut input).is_err() {
        "{\"error\":\"run_failed\",\"stage\":\"stdin\"}".to_string()
    } else {
        match (std::env::var("TRUENAV_DATA_URL"), std::env::var("TRUENAV_DATA_TOKEN")) {
            (Ok(base), Ok(token)) if base.starts_with("https://") && !token.is_empty() => {
                let clock = Clock { now: Box::new(|| iso_from_unix(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0))) };
                execute(&input, &tee_io::Https { base, token }, &tee_io::HostMac, &clock)
            }
            _ => "{\"error\":\"run_failed\",\"stage\":\"sealed_config\"}".to_string(),
        }
    };
    print!("{out}");
    let _ = std::io::stdout().flush();
}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    eprintln!("truenav-engine-v2: build with --target wasm32-wasip2 and run inside OutLayer; the logic is tested natively by cargo test");
}
