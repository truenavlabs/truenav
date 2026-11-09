//! No native signing path. Production executes only in OutLayer's WASI component host.
#[cfg(target_arch = "wasm32")]
mod host {
    wit_bindgen::generate!({world:"guest",path:"wit",generate_all});
}
#[cfg(target_arch = "wasm32")]
#[used]
#[link_section = "outlayer.manifest"]
static OUTLAYER_MANIFEST: [u8; include_bytes!("../manifest.json").len()] =
    *include_bytes!("../manifest.json");

#[cfg(target_arch = "wasm32")]
mod tee {
    use super::host::outlayer::encryption_keys::api as keys;
    use serde_json::{json, Value};
    use std::{
        collections::{BTreeMap, BTreeSet},
        time::Duration,
    };
    use truenav_engine_v3::{engine::*, rpc::*};
    use truenav_v3_core::source::*;
    use truenav_v3_core::{canonical, hash, parse, Result};
    pub struct HostMac;
    impl Fingerprinter for HostMac {
        fn mac(&self, msg: &[u8]) -> Result<[u8; 32]> {
            keys::mac("loan-terms-v2", None, msg)
                .map_err(|_| "host_mac")?
                .try_into()
                .map_err(|_| "host_mac")
        }
    }
    fn env(name: &str) -> Result<String> {
        std::env::var(name)
            .ok()
            .filter(|s| !s.is_empty())
            .ok_or("sealed_config")
    }
    fn https(url: &str) -> Result<()> {
        if !url.starts_with("https://") || url.contains('@') || url.contains('#') {
            Err("https_required")
        } else {
            Ok(())
        }
    }
    struct Rpc {
        url: String,
    }
    impl Transport for Rpc {
        fn post_json(&self, body: &Value) -> Result<Value> {
            let response = wasi_http_client::Client::new()
                .post(&self.url)
                .connect_timeout(Duration::from_secs(15))
                .json(body)
                .send()
                .map_err(|_| "rpc_transport")?;
            if response.status() != 200 {
                return Err("rpc_status");
            }
            let bytes = response.body().map_err(|_| "rpc_body")?;
            if bytes.len() > 2_000_000 {
                return Err("rpc_limit");
            }
            parse(&bytes)
        }
    }
    struct Documents {
        base: String,
        token: String,
    }
    impl Documents {
        fn fetch(&self, scope: &Scope, period: &Period) -> Result<Vec<SignedSource>> {
            let mut out = Vec::new();
            if !scope
                .token_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            {
                return Err("token_id");
            }
            for role in ["servicer", "bank", "fund_admin", "custodian"] {
                let url = format!(
                    "{}/v3/funds/{}/{role}?period_start={}&period_end={}",
                    self.base.trim_end_matches('/'),
                    scope.token_id,
                    period.period_start,
                    period.period_end
                );
                let response = wasi_http_client::Client::new()
                    .get(&url)
                    .connect_timeout(Duration::from_secs(15))
                    .header("Authorization", format!("Bearer {}", self.token))
                    .send()
                    .map_err(|_| "source_transport")?;
                if response.status() != 200 {
                    return Err("source_status");
                }
                if !response
                    .headers()
                    .iter()
                    .any(|(k, v)| k.eq_ignore_ascii_case("x-synthetic-data") && v == "true")
                {
                    return Err("synthetic_required");
                }
                let bytes = response.body().map_err(|_| "source_body")?;
                if bytes.len() > 2_000_000 {
                    return Err("source_limit");
                }
                out.push(serde_json::from_value(parse(&bytes)?).map_err(|_| "source_shape")?);
            }
            Ok(out)
        }
    }
    struct Reader {
        snapshot: Snapshot,
    }
    impl RegistryReader for Reader {
        fn read(&self, scope: &Scope, fp: &[String], _: &str) -> Result<Snapshot> {
            if self.snapshot.locks.len() != fp.len()
                || self
                    .snapshot
                    .locks
                    .iter()
                    .any(|r| !fp.contains(&r.fingerprint))
                || scope.network != "near_testnet"
            {
                return Err("registry_snapshot_invalid");
            }
            Ok(self.snapshot.clone())
        }
    }
    fn fingerprints(sources: &[SignedSource], c: &Context, p: &Policy) -> Result<Vec<String>> {
        let mut roles = BTreeSet::new();
        for s in sources {
            if !roles.insert(&s.source) {
                return Err("source_roles");
            }
            verify_source(
                s,
                &p.source_registry,
                &c.scope,
                &c.period,
                *p.minimum_revisions
                    .get(&s.source)
                    .ok_or("revision_policy_missing")?,
            )?;
        }
        if roles.len() != 4 {
            return Err("source_roles");
        }
        let terms = sources
            .iter()
            .find(|s| s.source == "custodian")
            .ok_or("source_roles")?
            .payload["loan_terms"]
            .as_array()
            .ok_or("loan_terms_missing")?;
        if terms.len() > 10000 {
            return Err("loan_tape_limit");
        }
        terms
            .iter()
            .map(|r| {
                let t: LoanTerms =
                    serde_json::from_value(r["terms"].clone()).map_err(|_| "loan_terms_invalid")?;
                fingerprint(&t, &p.case_sensitive_namespaces, &HostMac)
            })
            .collect()
    }
    fn context(v: &Value, now: &str) -> Result<Context> {
        Ok(Context {
            scope: Scope {
                network: v["network"].as_str().ok_or("request_context")?.into(),
                receipts_contract: v["receipts_contract"]
                    .as_str()
                    .ok_or("request_context")?
                    .into(),
                fund_account: v["fund_account"].as_str().ok_or("request_context")?.into(),
                token_id: v["token_id"].as_str().ok_or("request_context")?.into(),
            },
            period: Period {
                period_start: v["period_start"].as_str().ok_or("request_context")?.into(),
                period_end: v["period_end"].as_str().ok_or("request_context")?.into(),
            },
            seq: v["seq"].as_str().ok_or("request_context")?.into(),
            prev_receipt_sha256: v["prev_receipt_sha256"].as_str().map(str::to_string),
            supersedes_seq: v["supersedes_seq"].as_str().map(str::to_string),
            correction_reason_code: v["correction_reason_code"].as_str().map(str::to_string),
            request_id: v["request_id"].as_str().ok_or("request_context")?.into(),
            request_nonce: v["request_nonce"].as_str().ok_or("request_context")?.into(),
            engine_version_key: v["engine_version_key"]
                .as_str()
                .ok_or("request_context")?
                .into(),
            engine_code_sha256: v["engine_code_sha256"]
                .as_str()
                .ok_or("request_context")?
                .into(),
            valuation_time: v["judge_valuation_time"].as_str().unwrap_or(now).into(),
            issued_at: now.into(),
        })
    }
    fn previous_cash(request: &Value, c: &Context, policy: &mut Policy) -> Result<()> {
        let previous = &request["previous_receipt"];
        if c.prev_receipt_sha256.is_none() {
            if !previous.is_null() {
                return Err("previous_chain");
            }
            return Ok(());
        }
        if previous["receipt_sha256"].as_str() != c.prev_receipt_sha256.as_deref() {
            return Err("previous_chain");
        }
        let (passport, period) = if previous["receipt_version"] == "3" {
            #[cfg(not(feature = "dry-run-tests"))]
            truenav_v3_core::validate(previous)?;
            #[cfg(feature = "dry-run-tests")]
            if previous["receipts_contract"] == "receipts.tnlab-718ca9.testnet" {
                truenav_v3_core::validate(previous)?
            } else {
                truenav_v3_core::wire::validate_dry_run(previous, true)?
            }
            if previous["token_id"] != c.scope.token_id
                || previous["fund_account"] != c.scope.fund_account
            {
                return Err("previous_chain");
            }
            let commitment = previous["commitments"]["full_report"]
                .as_str()
                .ok_or("previous_report")?;
            let store = env("TRUENAV_REPORT_STORE_URL")?;
            https(&store)?;
            let token = env("TRUENAV_REPORT_STORE_TOKEN")?;
            let response = wasi_http_client::Client::new()
                .get(&format!("{}/{commitment}", store.trim_end_matches('/')))
                .header("Authorization", format!("Bearer {token}"))
                .connect_timeout(Duration::from_secs(15))
                .send()
                .map_err(|_| "previous_report")?;
            if response.status() != 200 {
                return Err("previous_report");
            }
            let sealed = parse(&response.body().map_err(|_| "previous_report")?)?;
            let aad = canonical(
                &json!({"network":previous["network"],"receipts_contract":previous["receipts_contract"],"token_id":previous["token_id"],"request_nonce":previous["request_nonce"],"full_report":commitment}),
            )?;
            let cipher = hex::decode(sealed["ciphertext_hex"].as_str().ok_or("previous_report")?)
                .map_err(|_| "previous_report")?;
            let plaintext = keys::decrypt("truenav-report-v3", None, &cipher, aad.as_bytes())
                .map_err(|_| "previous_report")?;
            let report = parse(&plaintext)?;
            let salt: [u8; 32] = hex::decode(
                report["certificate_salt"]
                    .as_str()
                    .ok_or("previous_report")?,
            )
            .map_err(|_| "previous_report")?
            .try_into()
            .map_err(|_| "previous_report")?;
            let nonce: [u8; 32] = hex::decode(
                previous["request_nonce"]
                    .as_str()
                    .ok_or("previous_report")?,
            )
            .map_err(|_| "previous_report")?
            .try_into()
            .map_err(|_| "previous_report")?;
            if truenav_v3_core::source::commitment("full_report", &report, &nonce, &salt)?
                != commitment
            {
                return Err("previous_report_binding");
            }
            (
                report["cash"]["passport"].clone(),
                previous["period_start"]
                    .as_str()
                    .ok_or("previous_period")?
                    .get(..7)
                    .ok_or("previous_period")?
                    .to_string(),
            )
        } else if previous["receipt_version"] == "2" {
            (
                previous["passport"].clone(),
                previous["period"]
                    .as_str()
                    .ok_or("previous_period")?
                    .to_string(),
            )
        } else {
            return Err("previous_version");
        };
        for row in passport.as_array().ok_or("previous_passport")? {
            policy.previous_cash_passport.push((
                row["source"].as_str().ok_or("previous_passport")?.into(),
                row["snapshot_sha256"]
                    .as_str()
                    .ok_or("previous_passport")?
                    .into(),
                row["as_of"].as_str().ok_or("previous_passport")?.into(),
            ));
        }
        policy.previous_period = Some(period);
        Ok(())
    }
    pub fn execute(input: &[u8]) -> Result<String> {
        if input.len() > 16384 {
            return Err("request_limit");
        }
        let request = parse(input)?;
        if request["receipt_version"] != "3" {
            return Err("request_version");
        }
        let unix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "clock")?
            .as_secs();
        let now = truenav_engine_v2::tee::iso_from_unix(unix as i64);
        let c = context(&request["context"], &now)?;
        if c.scope.network != "near_testnet" {
            return Err("testnet_only");
        }
        #[cfg(not(feature = "dry-run-tests"))]
        if c.scope.receipts_contract != "receipts.tnlab-718ca9.testnet" {
            return Err("contract_context");
        }
        let registry_bytes = env("TRUENAV_SOURCE_REGISTRY_JSON")?;
        let registry_json = parse(registry_bytes.as_bytes())?;
        if hash(canonical(&registry_json)?.as_bytes())
            != request["context"]["source_registry_sha256"]
        {
            return Err("source_registry_pin");
        }
        let registry: Registry =
            serde_json::from_value(registry_json).map_err(|_| "source_registry_invalid")?;
        registry.check()?;
        let minimum_revisions: BTreeMap<String, u64> =
            serde_json::from_str(&env("TRUENAV_SOURCE_MIN_REVISIONS_JSON")?)
                .map_err(|_| "revision_policy_missing")?;
        let namespaces: Vec<String> =
            serde_json::from_str(&env("TRUENAV_CASE_SENSITIVE_NAMESPACES_JSON")?)
                .map_err(|_| "namespace_policy_missing")?;
        let mut policy = Policy {
            source_registry: registry,
            minimum_revisions,
            case_sensitive_namespaces: namespaces,
            previous_cash_passport: vec![],
            previous_period: None,
        };
        previous_cash(&request, &c, &mut policy)?;
        let docs = Documents {
            base: env("TRUENAV_DATA_URL")?,
            token: env("TRUENAV_DATA_TOKEN")?,
        };
        https(&docs.base)?;
        let rpc = Rpc {
            url: env("TRUENAV_TESTNET_RPC_URL")?,
        };
        // Sealed testnet endpoint pin. No caller-selected URL and no mainnet endpoint.
        if ![
            "https://rpc.testnet.near.org",
            "https://test.rpc.fastnear.com",
        ]
        .contains(&rpc.url.as_str())
        {
            return Err("testnet_rpc_required");
        }
        let views = NearViews::finalized(&rpc)?;
        let sources = docs.fetch(&c.scope, &c.period)?;
        let fps = fingerprints(&sources, &c, &policy)?;
        let mut snapshot = views.snapshot(&c.scope, &fps, &c.valuation_time)?;
        let own = views.fund(&c.scope.token_id)?;
        // Operator-sealed full roster, never accepted from a source response or request caller.
        let roster: Vec<String> = serde_json::from_str(&env("TRUENAV_FUND_ROSTER_JSON")?)
            .map_err(|_| "manager_roster_missing")?;
        if roster.len() > 100
            || !roster.contains(&c.scope.token_id)
            || roster.iter().collect::<BTreeSet<_>>().len() != roster.len()
        {
            return Err("manager_roster_missing");
        }
        for id in &roster {
            if *id == c.scope.token_id {
                continue;
            }
            let fund = views.fund(id)?;
            if fund["manager_id"] != own["manager_id"] {
                continue;
            }
            let mut sibling = c.clone();
            sibling.scope.token_id = id.clone();
            sibling.scope.fund_account = fund["account_id"].as_str().ok_or("registry_fund")?.into();
            let src = docs.fetch(&sibling.scope, &sibling.period)?;
            let fps = fingerprints(&src, &sibling, &policy)?;
            let ss = views.snapshot(&sibling.scope, &fps, &sibling.valuation_time)?;
            let mut f = sibling_nav(&sibling, &src, &policy, &ss, &HostMac)?;
            f["certificate"]["manager_id"] = own["manager_id"].clone();
            snapshot.manager_funds.push(f);
        }
        let mut salt = [0u8; 32];
        getrandom::fill(&mut salt).map_err(|_| "tee_entropy")?;
        let out = evaluate(&c, &sources, &policy, &Reader { snapshot }, &HostMac, &salt)?;
        let report = canonical(&out.private_report)?;
        let aad = canonical(
            &json!({"network":c.scope.network,"receipts_contract":c.scope.receipts_contract,"token_id":c.scope.token_id,"request_nonce":c.request_nonce,"full_report":out.envelope["commitments"]["full_report"]}),
        )?;
        let ciphertext =
            keys::encrypt("truenav-report-v3", None, report.as_bytes(), aad.as_bytes())
                .map_err(|_| "report_encrypt")?;
        let store = env("TRUENAV_REPORT_STORE_URL")?;
        https(&store)?;
        let token = env("TRUENAV_REPORT_STORE_TOKEN")?;
        let payload = json!({"classification":"PRIVATE encrypted synthetic report","aad":aad,"full_report":out.envelope["commitments"]["full_report"],"ciphertext_hex":hex::encode(&ciphertext),"ciphertext_sha256":hash(&ciphertext)});
        let ack = wasi_http_client::Client::new()
            .post(&store)
            .connect_timeout(Duration::from_secs(15))
            .header("Authorization", format!("Bearer {token}"))
            .json(&payload)
            .send()
            .map_err(|_| "report_store")?;
        if ack.status() != 201 {
            return Err("report_store");
        }
        let ack = parse(&ack.body().map_err(|_| "report_store")?)?;
        if ack["full_report"] != payload["full_report"]
            || ack["ciphertext_sha256"] != payload["ciphertext_sha256"]
        {
            return Err("report_store_binding");
        }
        canonical(&out.execution_body())
    }
}
#[cfg(target_arch = "wasm32")]
fn main() {
    use std::io::{Read, Write};
    let mut input = Vec::new();
    let result = std::io::stdin()
        .take(16385)
        .read_to_end(&mut input)
        .map_err(|_| "stdin")
        .and_then(|_| tee::execute(&input));
    let public = match result {
        Ok(body) => body,
        Err(_) => "{\"error\":\"run_failed\",\"stage\":\"v3_closed\"}".into(),
    };
    print!("{public}");
    let _ = std::io::stdout().flush();
}
#[cfg(not(target_arch = "wasm32"))]
fn main() {
    eprintln!(
        "TrueNav v3: native execution disabled; run cargo test or build wasm32-wasip2 for OutLayer"
    );
}
