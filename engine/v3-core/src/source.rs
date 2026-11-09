use crate::{canonical, hash, timestamp, Result};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use unicode_normalization::UnicodeNormalization;

pub fn lp(out: &mut Vec<u8>, bytes: &[u8]) -> Result<()> {
    let n = u32::try_from(bytes.len()).map_err(|_| "framing_size")?;
    out.extend_from_slice(&n.to_be_bytes());
    out.extend_from_slice(bytes);
    Ok(())
}
pub fn commitment(label: &str, value: &Value, nonce: &[u8; 32], salt: &[u8; 32]) -> Result<String> {
    let allowed = [
        "inputs",
        "tape",
        "cash",
        "nav_report",
        "pledge_detail",
        "registry_state_root",
        "full_report",
        "nav_exact:reported_nav",
        "nav_exact:trueval",
        "nav_exact:truerange_low",
        "nav_exact:truerange_high",
        "score_exact:score_x100",
        "score_exact:parts_x100",
        "score_exact:raw_score",
    ];
    if !allowed.contains(&label) {
        return Err("commitment_label");
    }
    let mut bytes = Vec::new();
    for b in [
        b"truenav-v3".as_slice(),
        label.as_bytes(),
        nonce,
        salt,
        canonical(value)?.as_bytes(),
    ] {
        lp(&mut bytes, b)?
    }
    Ok(hash(&bytes))
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Scope {
    pub network: String,
    pub receipts_contract: String,
    pub fund_account: String,
    pub token_id: String,
    /// Registry fund id. Omitted when empty so previously signed scopes keep their bytes.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub fund_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Period {
    pub period_start: String,
    pub period_end: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SignedSource {
    pub source: String,
    pub key_id: String,
    pub scope: Scope,
    pub period: Period,
    pub revision: String,
    pub data_as_of: String,
    pub payload: Value,
    pub payload_sha256: String,
    pub signature: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceKey {
    pub key_id: String,
    pub role: String,
    pub fund_scope: Vec<String>,
    pub public_key: String,
    pub valid_from: String,
    pub valid_until: String,
    pub revoked: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Registry {
    pub registry_version: String,
    pub keys: Vec<SourceKey>,
}
impl Registry {
    pub fn check(&self) -> Result<()> {
        let v = serde_json::to_value(self).map_err(|_| "source_registry_invalid")?;
        let schema: Value = serde_json::from_str(include_str!(
            "../../../schema/source-key-registry.schema.json"
        ))
        .expect("frozen key schema");
        crate::wire::validate_schema(&v, &schema).map_err(|_| "source_registry_invalid")?;
        if self.keys.len() > 1000 {
            return Err("source_registry_invalid");
        }
        let mut seen = std::collections::BTreeSet::new();
        let mut modes = std::collections::BTreeSet::new();
        for key in &self.keys {
            modes.insert(
                key.key_id
                    .split(':')
                    .nth(1)
                    .is_some_and(|s| s.starts_with("live_")),
            );
            if !seen.insert(&key.key_id)
                || !key.key_id.starts_with(&format!("{}:", key.role))
                || timestamp(&key.valid_from)? >= timestamp(&key.valid_until)?
                || key.fund_scope.iter().any(|s| s == "*")
            {
                return Err("source_registry_invalid");
            }
        }
        if modes.len() > 1 {
            return Err("source_registry_mixed_modes");
        }
        Ok(())
    }
    pub fn check_live(&self) -> Result<()> {
        self.check()?;
        if self.keys.is_empty()
            || self.keys.iter().any(|k| {
                !k.key_id
                    .split(':')
                    .nth(1)
                    .is_some_and(|s| s.starts_with("live_"))
            })
        {
            return Err("source_registry_live_required");
        }
        Ok(())
    }
}
/// One explicit fixture OR live trust context. A previously loaded ID can never change key bytes.
pub struct RegistrySession {
    live: bool,
    bindings: std::collections::BTreeMap<String, String>,
}
impl RegistrySession {
    pub fn new(live: bool) -> Self {
        Self {
            live,
            bindings: Default::default(),
        }
    }
    pub fn load(&mut self, registry: &Registry) -> Result<()> {
        registry.check()?;
        if self.live {
            registry.check_live()?;
        } else if registry.keys.iter().any(|k| {
            k.key_id
                .split(':')
                .nth(1)
                .is_some_and(|s| s.starts_with("live_"))
        }) {
            return Err("source_registry_mixed_modes");
        }
        for key in &registry.keys {
            if self
                .bindings
                .get(&key.key_id)
                .is_some_and(|p| p != &key.public_key)
            {
                return Err("source_key_rebound");
            }
        }
        for key in &registry.keys {
            self.bindings
                .insert(key.key_id.clone(), key.public_key.clone());
        }
        Ok(())
    }
}
fn bound_scope(scope: &Scope) -> Scope {
    scope.clone()
}
pub fn source_preimage(s: &SignedSource) -> Result<Vec<u8>> {
    let scope = canonical(&serde_json::to_value(&bound_scope(&s.scope)).map_err(|_| "source_scope_mismatch")?)?;
    let period = canonical(&serde_json::to_value(&s.period).map_err(|_| "source_period")?)?;
    let payload = hex::decode(&s.payload_sha256).map_err(|_| "source_digest")?;
    if payload.len() != 32 {
        return Err("source_digest");
    }
    let mut out = Vec::new();
    for b in [
        b"truenav-src-v1".as_slice(),
        s.source.as_bytes(),
        s.key_id.as_bytes(),
        scope.as_bytes(),
        period.as_bytes(),
        s.revision.as_bytes(),
        s.data_as_of.as_bytes(),
        &payload,
    ] {
        lp(&mut out, b)?
    }
    Ok(out)
}
/// Verification happens before reading a payload's financial values. Errors contain fixed codes only.
pub fn verify_source(
    s: &SignedSource,
    keys: &Registry,
    scope: &Scope,
    period: &Period,
    min_revision: u64,
) -> Result<()> {
    let key = keys
        .keys
        .iter()
        .find(|k| k.key_id == s.key_id)
        .ok_or("source_key_unknown")?;
    if !["servicer", "bank", "fund_admin", "custodian"].contains(&s.source.as_str())
        || key.role != s.source
        || !s.key_id.starts_with(&format!("{}:", s.source))
    {
        return Err("source_key_unknown");
    }
    if key.revoked {
        return Err("source_key_revoked");
    }
    if !key.fund_scope.contains(&scope.token_id)
        || canonical(&serde_json::to_value(&bound_scope(&s.scope)).map_err(|_| "source_scope_mismatch")?)?
            != canonical(&serde_json::to_value(&bound_scope(scope)).map_err(|_| "source_scope_mismatch")?)?
    {
        return Err("source_scope_mismatch");
    }
    if s.period.period_start != period.period_start || s.period.period_end != period.period_end {
        return Err("source_scope_mismatch");
    }
    let at = timestamp(&s.data_as_of)?;
    if at < timestamp(&key.valid_from)? || at >= timestamp(&key.valid_until)? {
        return Err("source_key_expired");
    }
    let revision = s
        .revision
        .parse::<u64>()
        .map_err(|_| "source_revision_replay")?;
    if revision < min_revision || revision == 0 || s.revision != revision.to_string() {
        return Err("source_revision_replay");
    }
    if s.payload_sha256 != hash(canonical(&s.payload)?.as_bytes()) {
        return Err("source_signature_invalid");
    }
    let raw = key
        .public_key
        .strip_prefix("ed25519:")
        .ok_or("source_signature_invalid")?;
    let pubbytes: [u8; 32] = hex::decode(raw)
        .map_err(|_| "source_signature_invalid")?
        .try_into()
        .map_err(|_| "source_signature_invalid")?;
    let sigbytes: [u8; 64] = hex::decode(&s.signature)
        .map_err(|_| "source_signature_invalid")?
        .try_into()
        .map_err(|_| "source_signature_invalid")?;
    let digest = sha2_bytes(&source_preimage(s)?);
    VerifyingKey::from_bytes(&pubbytes)
        .map_err(|_| "source_signature_invalid")?
        .verify_strict(&digest, &Signature::from_bytes(&sigbytes))
        .map_err(|_| "source_signature_invalid")
}
pub fn sha2_bytes(data: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    Sha256::digest(data).into()
}

/// Namespace case policy is supplied by the trusted deployment configuration, never the issuer.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LoanTerms {
    pub version: String,
    pub borrower_namespace: String,
    pub borrower_id: String,
    pub origination_date: String,
    pub principal_cents: String,
    pub currency: String,
    pub collateral_namespace: String,
    pub collateral_ref: String,
}
fn is_dropped_char(c: char) -> bool {
    c.is_whitespace()
        || c.is_control()
        || matches!(
            c,
            '\u{00ad}'
                | '\u{034f}'
                | '\u{061c}'
                | '\u{180e}'
                | '\u{200b}'..='\u{200f}'
                | '\u{202a}'..='\u{202e}'
                | '\u{2060}'..='\u{206f}'
                | '\u{feff}'
                | '\u{115f}'
                | '\u{1160}'
                | '\u{17b4}'
                | '\u{17b5}'
                | '\u{3164}'
                | '\u{ffa0}'
        )
}
/// NFKC, drop Unicode whitespace and invisible characters, then Unicode lowercase unless the namespace is case sensitive.
/// Confusable skeletons are not applied: no vetted skeleton crate is linked, and accented ids must still compare equal.
pub fn normalized_id(s: &str, case_sensitive: bool) -> Result<String> {
    let nfkc: String = s.nfkc().collect();
    let mut n = String::new();
    for c in nfkc.chars() {
        if !is_dropped_char(c) {
            n.push(c);
        }
    }
    if n.is_empty() || n.len() > 512 {
        return Err("loan_terms_invalid");
    }
    if case_sensitive {
        Ok(n)
    } else {
        Ok(n.to_lowercase())
    }
}
/// Document identity. A trailing `-copy` is the same document (rename evasion).
pub fn document_root(id: &str) -> Result<String> {
    let n = normalized_id(id, false)?;
    Ok(n.strip_suffix("-copy").unwrap_or(&n).to_string())
}
/// Borrower identity. One short hyphen suffix (`-a`, `-1`) is a split marker, not a new borrower.
pub fn borrower_root(id: &str) -> Result<String> {
    let n = normalized_id(id, false)?;
    if let Some((base, suffix)) = n.rsplit_once('-') {
        if !base.is_empty()
            && (1..=4).contains(&suffix.len())
            && suffix.chars().all(|c| c.is_ascii_alphanumeric())
        {
            return Ok(base.to_string());
        }
    }
    Ok(n)
}
pub fn canonical_terms(t: &LoanTerms, case_sensitive_namespaces: &[String]) -> Result<Value> {
    if t.version != "loan-terms-v2" || t.currency != "USD" || t.origination_date.len() != 10 {
        return Err("loan_terms_invalid");
    }
    timestamp(&format!("{}T00:00:00Z", t.origination_date)).map_err(|_| "loan_terms_invalid")?;
    let principal = t
        .principal_cents
        .parse::<u128>()
        .map_err(|_| "loan_terms_invalid")?;
    if principal > i128::MAX as u128 || t.principal_cents != principal.to_string() {
        return Err("loan_terms_invalid");
    }
    let ns_ok = |s: &str| {
        !s.is_empty()
            && s.len() <= 32
            && s.bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_' || c == b'-')
    };
    if !ns_ok(&t.borrower_namespace) || !ns_ok(&t.collateral_namespace) {
        return Err("loan_terms_invalid");
    }
    Ok(
        json!({"version":"loan-terms-v2","borrower_namespace":t.borrower_namespace,"borrower_id":normalized_id(&t.borrower_id,case_sensitive_namespaces.contains(&t.borrower_namespace))?,"origination_date":t.origination_date,"principal_cents":t.principal_cents,"currency":"USD","collateral_namespace":t.collateral_namespace,"collateral_ref":normalized_id(&t.collateral_ref,case_sensitive_namespaces.contains(&t.collateral_namespace))?}),
    )
}
pub fn loan_terms_message(t: &LoanTerms, case_sensitive_namespaces: &[String]) -> Result<Vec<u8>> {
    let v = canonical_terms(t, case_sensitive_namespaces)?;
    let mut pre = Vec::new();
    lp(&mut pre, b"loan-terms-v2")?;
    lp(&mut pre, canonical(&v)?.as_bytes())?;
    Ok(sha2_bytes(&pre).to_vec())
}
/// The MAC implementation comes from OutLayer's common project/caller key, not source data.
pub trait Fingerprinter {
    fn mac(&self, message: &[u8]) -> Result<[u8; 32]>;
}
/// Pledge identity is the canonical document id under one domain.
/// Principal, dates, and borrower spelling are not part of the hash.
/// Lookup also covers the v3 domain (document plus borrower root) and the invoices v1 string.
/// Same document id with a different borrower, or a borrower/document suffix (`-a`, `-copy`), is the same loan.
pub fn fingerprint(
    t: &LoanTerms,
    _case_sensitive_namespaces: &[String],
    mac: &dyn Fingerprinter,
) -> Result<String> {
    let doc = document_root(&t.collateral_ref)?;
    let _ = borrower_root(&t.borrower_id)?;
    Ok(hex::encode(mac.mac(format!("truenav-fp-v1|real_estate|{doc}").as_bytes())?))
}
pub fn pledge_lookup_hashes(
    t: &LoanTerms,
    case_sensitive_namespaces: &[String],
    mac: &dyn Fingerprinter,
) -> Result<Vec<String>> {
    let primary = fingerprint(t, case_sensitive_namespaces, mac)?;
    let doc = document_root(&t.collateral_ref)?;
    let borrower = borrower_root(&t.borrower_id)?;
    let mut framed = Vec::new();
    lp(&mut framed, b"truenav-fp-v3")?;
    lp(&mut framed, doc.as_bytes())?;
    lp(&mut framed, borrower.as_bytes())?;
    let mut out = vec![
        primary,
        hex::encode(mac.mac(&framed)?),
        hex::encode(mac.mac(format!("truenav-fp-v1|invoices|{doc}").as_bytes())?),
    ];
    let raw = normalized_id(&t.collateral_ref, false)?;
    if raw != doc {
        out.push(hex::encode(
            mac.mac(format!("truenav-fp-v1|real_estate|{raw}").as_bytes())?,
        ));
    }
    Ok(out)
}
