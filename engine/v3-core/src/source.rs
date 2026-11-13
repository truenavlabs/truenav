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
    /// Registry fund id. v3 sources must set it. An empty value is `source_scope_mismatch`.
    #[serde(default)]
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
pub fn source_preimage(s: &SignedSource) -> Result<Vec<u8>> {
    let scope = canonical(&serde_json::to_value(&s.scope).map_err(|_| "source_scope_mismatch")?)?;
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
    if s.scope.fund_id.is_empty() || scope.fund_id.is_empty() {
        return Err("source_scope_mismatch");
    }
    if !key.fund_scope.contains(&scope.token_id)
        || canonical(&serde_json::to_value(&s.scope).map_err(|_| "source_scope_mismatch")?)?
            != canonical(&serde_json::to_value(scope).map_err(|_| "source_scope_mismatch")?)?
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
/// Unicode Default_Ignorable_Code_Point, every range in DerivedCoreProperties-18.0.0.txt
/// (https://www.unicode.org/Public/UCD/latest/ucd/DerivedCoreProperties.txt, dated 2026-08-07),
/// including the code points Unicode reserves for future ignorables. The same lines are kept in
/// tests/fixtures/unicode-18.0.0-default-ignorable.txt and tests/redteam_a01.rs checks this table
/// against them (Codex audit A01: the earlier hand list missed U+180F and the reserved ranges).
const DEFAULT_IGNORABLE: [(u32, u32); 27] = [
    (0x00AD, 0x00AD),   // Cf       SOFT HYPHEN
    (0x034F, 0x034F),   // Mn       COMBINING GRAPHEME JOINER
    (0x061C, 0x061C),   // Cf       ARABIC LETTER MARK
    (0x115F, 0x1160),   // Lo   [2] HANGUL CHOSEONG FILLER..HANGUL JUNGSEONG FILLER
    (0x17B4, 0x17B5),   // Mn   [2] KHMER VOWEL INHERENT AQ..KHMER VOWEL INHERENT AA
    (0x180B, 0x180D), // Mn   [3] MONGOLIAN FREE VARIATION SELECTOR ONE..MONGOLIAN FREE VARIATION SELECTOR THREE
    (0x180E, 0x180E), // Cf       MONGOLIAN VOWEL SEPARATOR
    (0x180F, 0x180F), // Mn       MONGOLIAN FREE VARIATION SELECTOR FOUR
    (0x200B, 0x200F), // Cf   [5] ZERO WIDTH SPACE..RIGHT-TO-LEFT MARK
    (0x202A, 0x202E), // Cf   [5] LEFT-TO-RIGHT EMBEDDING..RIGHT-TO-LEFT OVERRIDE
    (0x2060, 0x2064), // Cf   [5] WORD JOINER..INVISIBLE PLUS
    (0x2065, 0x2065), // Cn       <reserved-2065>
    (0x2066, 0x206F), // Cf  [10] LEFT-TO-RIGHT ISOLATE..NOMINAL DIGIT SHAPES
    (0x3164, 0x3164), // Lo       HANGUL FILLER
    (0xFE00, 0xFE0F), // Mn  [16] VARIATION SELECTOR-1..VARIATION SELECTOR-16
    (0xFEFF, 0xFEFF), // Cf       ZERO WIDTH NO-BREAK SPACE
    (0xFFA0, 0xFFA0), // Lo       HALFWIDTH HANGUL FILLER
    (0xFFF0, 0xFFF8), // Cn   [9] <reserved-FFF0>..<reserved-FFF8>
    (0x1BCA0, 0x1BCA3), // Cf   [4] SHORTHAND FORMAT LETTER OVERLAP..SHORTHAND FORMAT UP STEP
    (0x1D173, 0x1D17A), // Cf   [8] MUSICAL SYMBOL BEGIN BEAM..MUSICAL SYMBOL END PHRASE
    (0xE0000, 0xE0000), // Cn       <reserved-E0000>
    (0xE0001, 0xE0001), // Cf       LANGUAGE TAG
    (0xE0002, 0xE001F), // Cn  [30] <reserved-E0002>..<reserved-E001F>
    (0xE0020, 0xE007F), // Cf  [96] TAG SPACE..CANCEL TAG
    (0xE0080, 0xE00FF), // Cn [128] <reserved-E0080>..<reserved-E00FF>
    (0xE0100, 0xE01EF), // Mn [240] VARIATION SELECTOR-17..VARIATION SELECTOR-256
    (0xE01F0, 0xE0FFF), // Cn [3600] <reserved-E01F0>..<reserved-E0FFF>
];
/// Dropped before A01 although not in Default_Ignorable_Code_Point; kept so existing ids do not move.
const EXTRA_IGNORABLE: [(u32, u32); 2] = [
    (0xFFF9, 0xFFFB),   // Cf interlinear annotation anchor..terminator
    (0x13430, 0x13438), // Cf Egyptian hieroglyph format controls
];
/// Unicode Default_Ignorable_Code_Point plus the two extra ranges above.
/// These are removed so they cannot mint a second pledge id.
pub fn is_default_ignorable(c: char) -> bool {
    let cp = c as u32;
    DEFAULT_IGNORABLE
        .iter()
        .chain(EXTRA_IGNORABLE.iter())
        .any(|(a, b)| (*a..=*b).contains(&cp))
}
fn is_dropped_char(c: char) -> bool {
    c.is_whitespace() || c.is_control() || is_default_ignorable(c)
}
/// Letters that copy a Latin shape and that NFKC does not fold. Not a full confusable skeleton.
fn latin_lookalike(c: char) -> char {
    match c {
        'А' | 'а' | 'Α' | 'α' => 'a',
        'В' | 'в' | 'Β' | 'β' => 'b',
        'Е' | 'е' | 'Ε' => 'e',
        'К' | 'к' | 'Κ' | 'κ' => 'k',
        'М' | 'м' | 'Μ' => 'm',
        'Н' | 'н' | 'Η' => 'h',
        'О' | 'о' | 'Ο' | 'ο' => 'o',
        'Р' | 'р' | 'Ρ' => 'p',
        'С' | 'с' | 'Ϲ' => 'c',
        'Т' | 'т' | 'Τ' | 'τ' => 't',
        'У' | 'у' => 'y',
        'Х' | 'х' | 'Χ' | 'χ' => 'x',
        'І' | 'і' | 'Ι' | 'ι' => 'i',
        'Ј' | 'ј' => 'j',
        'Ѕ' | 'ѕ' => 's',
        _ => c,
    }
}
/// Lowercase forms whose uppercase is in `latin_lookalike`, so case folding cannot undo the fold
/// (Codex audit A01: `Ε` became `e` but `ε` stayed `ε`).
fn lowercase_lookalike(c: char) -> char {
    match c {
        'ε' => 'e',
        'η' => 'h',
        'μ' => 'm',
        'ρ' => 'p',
        'ϲ' => 'c',
        _ => latin_lookalike(c),
    }
}
/// One case-folding pass: Unicode uppercase then lowercase (so `µ`, `ı`, `ͅ`, `ᾈ` meet their pairs),
/// NFKD, the casefold pairs the lowercase table misses, the lowercase lookalike set on base letters,
/// then NFKC.
fn fold_case(n: &str) -> String {
    let lower: String = n.to_uppercase().to_lowercase().nfkd().collect();
    let mut out = String::new();
    for c in lower.chars() {
        if c == '\u{0307}' && out.ends_with('i') {
            continue;
        }
        match c {
            'ς' => out.push('σ'),
            'ß' => out.push_str("ss"),
            other => out.push(lowercase_lookalike(other)),
        }
    }
    out.nfkc().collect()
}
/// Fold the lookalike set on the canonically decomposed input first, because NFKC rewrites some
/// mapped letters (U+03F9 and U+03F2 become sigma) before a later map could see them. Then NFKC,
/// drop whitespace and default-ignorable characters, fold the Latin lookalike set again on the
/// decomposed base letters, then NFKC so a letter and its mark compose even when an ignorable sat
/// between them, then (unless the namespace is case-sensitive) case folding to a fixed point.
/// A full confusable skeleton crate is not linked.
pub fn normalized_id(s: &str, case_sensitive: bool) -> Result<String> {
    let folded: String = s
        .nfd()
        .map(|c| {
            if case_sensitive {
                latin_lookalike(c)
            } else {
                lowercase_lookalike(c)
            }
        })
        .collect();
    let nfkc: String = folded.nfkc().collect();
    let kept: String = nfkc.chars().filter(|c| !is_dropped_char(*c)).collect();
    let n: String = kept
        .nfkd()
        .map(latin_lookalike)
        .collect::<String>()
        .nfkc()
        .collect();
    if n.is_empty() || n.len() > 512 {
        return Err("loan_terms_invalid");
    }
    if case_sensitive {
        return Ok(n);
    }
    let mut out = fold_case(&n);
    for _ in 0..4 {
        let next = fold_case(&out);
        if next == out {
            break;
        }
        out = next;
    }
    if out.is_empty() || out.len() > 512 || fold_case(&out) != out {
        return Err("loan_terms_invalid");
    }
    Ok(out)
}
/// Document identity: NFKC, Unicode lowercase, whitespace and invisible characters removed.
/// Suffixes such as `-copy` or `-v2` are not stripped. A fund that controls its own ids can rename
/// them. The pledge anchor is the external namespace plus this ref, attested by the signed source key.
pub fn document_root(id: &str) -> Result<String> {
    normalized_id(id, false)
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
/// Shared pledge preimage. Producers and the NAV check MAC these bytes under key path `loan-terms-v2`.
/// Domain `truenav-fp-v4`, length-prefixed: asset class, collateral namespace, document root.
/// `case_sensitive` keeps the namespace and the document root's case. The default folds case.
pub fn pledge_message(
    asset_class: &str,
    collateral_namespace: &str,
    collateral_ref: &str,
) -> Result<Vec<u8>> {
    pledge_message_cased(asset_class, collateral_namespace, collateral_ref, false)
}
pub fn pledge_message_cased(
    asset_class: &str,
    collateral_namespace: &str,
    collateral_ref: &str,
    case_sensitive: bool,
) -> Result<Vec<u8>> {
    let asset = normalized_id(asset_class, false)?;
    let ns = normalized_id(collateral_namespace, case_sensitive)?;
    let doc = if case_sensitive {
        normalized_id(collateral_ref, true)?
    } else {
        document_root(collateral_ref)?
    };
    let mut framed = Vec::new();
    lp(&mut framed, b"truenav-fp-v4")?;
    lp(&mut framed, asset.as_bytes())?;
    lp(&mut framed, ns.as_bytes())?;
    lp(&mut framed, doc.as_bytes())?;
    Ok(framed)
}
/// Pledge identity is `pledge_message` under the caller's MAC.
/// Principal, dates, and borrower are not in the hash.
/// The same ref in two namespaces is two loans.
/// A namespace listed in `case_sensitive_namespaces` does not casefold its document root.
pub fn fingerprint(
    t: &LoanTerms,
    asset_class: &str,
    case_sensitive_namespaces: &[String],
    mac: &dyn Fingerprinter,
) -> Result<String> {
    let sensitive = case_sensitive_namespaces
        .iter()
        .any(|n| n == &t.collateral_namespace);
    Ok(hex::encode(mac.mac(&pledge_message_cased(
        asset_class,
        &t.collateral_namespace,
        &t.collateral_ref,
        sensitive,
    )?)?))
}
/// Lookup hashes. The only entry is the v4 identity.
/// The v1 pipe alias is not queried. Historical locks were MACed as
/// `truenav-fp-v1|{asset}|{DOCUMENT}` under path `loan-fingerprint` in the servicer project.
/// That is a different OutLayer key. A second hash under `loan-terms-v2` cannot find them.
/// Those locks have to be released and pledged again under v4.
pub fn pledge_lookup_hashes(
    t: &LoanTerms,
    asset_class: &str,
    case_sensitive_namespaces: &[String],
    mac: &dyn Fingerprinter,
) -> Result<Vec<String>> {
    Ok(vec![fingerprint(
        t,
        asset_class,
        case_sensitive_namespaces,
        mac,
    )?])
}
