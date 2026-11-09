use crate::Result;
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fmt;

pub const METHOD: &str = include_str!("../../../schema/methods/truenav-v3.0.0-rc3.json");
pub const SCHEMA: &str = include_str!("../../../schema/receipt-v3.schema.json");
pub const MAX_PUBLIC_BYTES: usize = 10_000;
pub fn hash(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
pub fn method_hash() -> String {
    hash(
        canonical(&serde_json::from_str(METHOD).expect("frozen artifact"))
            .expect("frozen canonical")
            .as_bytes(),
    )
}

struct Strict(Value);
impl<'de> Deserialize<'de> for Strict {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Strict;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("JSON without duplicate keys")
            }
            fn visit_bool<E: de::Error>(self, v: bool) -> std::result::Result<Strict, E> {
                Ok(Strict(Value::Bool(v)))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> std::result::Result<Strict, E> {
                Ok(Strict(v.into()))
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> std::result::Result<Strict, E> {
                Ok(Strict(v.into()))
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> std::result::Result<Strict, E> {
                serde_json::Number::from_f64(v)
                    .map(|n| Strict(Value::Number(n)))
                    .ok_or_else(|| E::custom("invalid_number"))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> std::result::Result<Strict, E> {
                Ok(Strict(Value::String(v.into())))
            }
            fn visit_string<E: de::Error>(self, v: String) -> std::result::Result<Strict, E> {
                Ok(Strict(Value::String(v)))
            }
            fn visit_unit<E: de::Error>(self) -> std::result::Result<Strict, E> {
                Ok(Strict(Value::Null))
            }
            fn visit_none<E: de::Error>(self) -> std::result::Result<Strict, E> {
                Ok(Strict(Value::Null))
            }
            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut a: A,
            ) -> std::result::Result<Strict, A::Error> {
                let mut out = Vec::new();
                while let Some(Strict(x)) = a.next_element()? {
                    out.push(x)
                }
                Ok(Strict(Value::Array(out)))
            }
            fn visit_map<A: MapAccess<'de>>(
                self,
                mut a: A,
            ) -> std::result::Result<Strict, A::Error> {
                let mut out = Map::new();
                while let Some((k, Strict(v))) = a.next_entry::<String, Strict>()? {
                    if out.contains_key(&k) {
                        return Err(de::Error::custom("duplicate_key"));
                    }
                    out.insert(k, v);
                }
                Ok(Strict(Value::Object(out)))
            }
        }
        d.deserialize_any(V)
    }
}
pub fn parse(bytes: &[u8]) -> Result<Value> {
    let mut d = serde_json::Deserializer::from_slice(bytes);
    let Strict(v) = Strict::deserialize(&mut d).map_err(|_| "invalid_json")?;
    d.end().map_err(|_| "invalid_json")?;
    Ok(v)
}
pub fn canonical(v: &Value) -> Result<String> {
    fn put(v: &Value, o: &mut String, depth: usize) -> Result<()> {
        if depth > 64 {
            return Err("json_depth");
        }
        match v {
            Value::Null => o.push_str("null"),
            Value::Bool(b) => o.push_str(if *b { "true" } else { "false" }),
            Value::String(s) => o.push_str(&serde_json::to_string(s).map_err(|_| "json_string")?),
            Value::Number(n) => {
                let x = n.as_f64().ok_or("json_number")?;
                if !x.is_finite() {
                    return Err("json_number");
                }
                if n.as_i64()
                    .is_some_and(|x| x.unsigned_abs() > 9_007_199_254_740_991)
                    || n.as_u64().is_some_and(|x| x > 9_007_199_254_740_991)
                {
                    return Err("unsafe_json_integer");
                }
                o.push_str(ryu_js::Buffer::new().format_finite(x));
            }
            Value::Array(xs) => {
                o.push('[');
                for (i, x) in xs.iter().enumerate() {
                    if i > 0 {
                        o.push(',')
                    }
                    put(x, o, depth + 1)?
                }
                o.push(']')
            }
            Value::Object(m) => {
                o.push('{');
                let mut ks: Vec<_> = m.keys().collect();
                ks.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
                for (i, k) in ks.iter().enumerate() {
                    if i > 0 {
                        o.push(',')
                    }
                    o.push_str(&serde_json::to_string(k).map_err(|_| "json_string")?);
                    o.push(':');
                    put(&m[*k], o, depth + 1)?
                }
                o.push('}')
            }
        }
        Ok(())
    }
    let mut s = String::new();
    put(v, &mut s, 0)?;
    Ok(s)
}
pub fn envelope_hash(e: &Value) -> Result<String> {
    let mut e = e.clone();
    e.as_object_mut()
        .ok_or("receipt_object")?
        .remove("receipt_sha256");
    if e.get("attestation_status").is_some() {
        return Err("reader_status_in_receipt");
    }
    Ok(hash(canonical(&e)?.as_bytes()))
}
pub fn seal_envelope(e: &mut Value) -> Result<()> {
    e["receipt_sha256"] = Value::String(envelope_hash(e)?);
    Ok(())
}

/// Milliseconds, strict Gregorian UTC seconds only. Never formats attacker data into errors.
pub fn timestamp(s: &str) -> Result<i64> {
    let b = s.as_bytes();
    if b.len() != 20
        || !b.is_ascii()
        || b[4] != b'-'
        || b[7] != b'-'
        || b[10] != b'T'
        || b[13] != b':'
        || b[16] != b':'
        || b[19] != b'Z'
    {
        return Err("utc_timestamp");
    }
    let n = |a: usize, z: usize| -> Result<i64> {
        if !b[a..z].iter().all(u8::is_ascii_digit) {
            return Err("utc_timestamp");
        }
        s[a..z].parse().map_err(|_| "utc_timestamp")
    };
    let (y, m, d, h, mi, se) = (
        n(0, 4)?,
        n(5, 7)?,
        n(8, 10)?,
        n(11, 13)?,
        n(14, 16)?,
        n(17, 19)?,
    );
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let md = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if leap {
                29
            } else {
                28
            }
        }
        _ => return Err("utc_timestamp"),
    };
    if y < 1 || d < 1 || d > md || h > 23 || mi > 59 || se > 59 {
        return Err("utc_timestamp");
    }
    let yy = y - i64::from(m <= 2);
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let mp = m + if m > 2 { -3 } else { 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Ok(((days * 24 + h) * 60 + mi) * 60 * 1000 + se * 1000)
}
// These are the complete literal pattern set in the two immutable schemas. Unknown patterns fail closed.
// Avoid compiling a general regular-expression engine inside a metered NEAR callback.
fn frozen_pattern(s: &str, p: &str) -> bool {
    let hex64 = |x: &str| {
        x.len() == 64
            && x.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    };
    let alnum = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    let dec = |x: &str, max: usize| {
        !x.is_empty()
            && x.len() <= max
            && x.bytes().all(|b| b.is_ascii_digit())
            && (x == "0" || x.as_bytes()[0] != b'0')
    };
    match p {
        "^[0-9a-f]{64}$" => hex64(s),
        "^sha256:[0-9a-f]{64}$" => s.strip_prefix("sha256:").is_some_and(hex64),
        "^ed25519:[0-9a-f]{64}$" => s.strip_prefix("ed25519:").is_some_and(hex64),
        "^(0|[1-9][0-9]{0,19})$" => dec(s, 20),
        "^-?(0|[1-9][0-9]{0,38})$" => dec(s.strip_prefix('-').unwrap_or(s), 39),
        "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$" => timestamp(s).is_ok(),
        "^[a-z0-9][a-z0-9._-]{0,62}[a-z0-9]$" => {
            (2..=64).contains(&s.len())
                && alnum(s.as_bytes()[0])
                && alnum(s.as_bytes()[s.len() - 1])
                && s.bytes()
                    .all(|b| alnum(b) || b == b'.' || b == b'_' || b == b'-')
        }
        "^(servicer|bank|fund_admin|custodian):[a-z0-9][a-z0-9_-]{0,31}:v[1-9][0-9]{0,8}$" => {
            let parts: Vec<_> = s.split(':').collect();
            parts.len() == 3
                && ["servicer", "bank", "fund_admin", "custodian"].contains(&parts[0])
                && (1..=32).contains(&parts[1].len())
                && alnum(parts[1].as_bytes()[0])
                && parts[1].bytes().all(|b| alnum(b) || b == b'_' || b == b'-')
                && parts[2]
                    .strip_prefix('v')
                    .is_some_and(|v| v != "0" && dec(v, 9))
        }
        _ => false,
    }
}
fn schema_match(v: &Value, s: &Value) -> bool {
    if let Some(c) = s.get("const") {
        if v != c {
            return false;
        }
    }
    if let Some(a) = s.get("enum").and_then(Value::as_array) {
        if !a.contains(v) {
            return false;
        }
    }
    if let Some(a) = s.get("anyOf").and_then(Value::as_array) {
        if !a.iter().any(|x| schema_match(v, x)) {
            return false;
        }
    }
    if let Some(a) = s.get("allOf").and_then(Value::as_array) {
        if !a.iter().all(|x| schema_match(v, x)) {
            return false;
        }
    }
    if let Some(n) = s.get("not") {
        if schema_match(v, n) {
            return false;
        }
    }
    if let Some(i) = s.get("if") {
        if schema_match(v, i) {
            if let Some(t) = s.get("then") {
                if !schema_match(v, t) {
                    return false;
                }
            }
        }
    }
    if let Some(t) = s.get("type").and_then(Value::as_str) {
        if !match t {
            "null" => v.is_null(),
            "object" => v.is_object(),
            "array" => v.is_array(),
            "string" => v.is_string(),
            "integer" => v.as_i64().is_some() || v.as_u64().is_some(),
            "number" => v.is_number(),
            "boolean" => v.is_boolean(),
            _ => false,
        } {
            return false;
        }
    }
    if let Some(m) = v.as_object() {
        if let Some(req) = s.get("required").and_then(Value::as_array) {
            if req
                .iter()
                .any(|k| k.as_str().is_none_or(|k| !m.contains_key(k)))
            {
                return false;
            }
        }
        if let Some(props) = s.get("properties").and_then(Value::as_object) {
            for (k, x) in m {
                match props.get(k) {
                    Some(s) => {
                        if !schema_match(x, s) {
                            return false;
                        }
                    }
                    None => {
                        if s.get("additionalProperties") == Some(&Value::Bool(false)) {
                            return false;
                        }
                    }
                }
            }
        }
    }
    if let Some(xs) = v.as_array() {
        if s.get("minItems")
            .and_then(Value::as_u64)
            .is_some_and(|n| xs.len() < (n as usize))
            || s.get("maxItems")
                .and_then(Value::as_u64)
                .is_some_and(|n| xs.len() > (n as usize))
        {
            return false;
        }
        if let Some(items) = s.get("items") {
            if !xs.iter().all(|x| schema_match(x, items)) {
                return false;
            }
        }
        if let Some(c) = s.get("contains") {
            if !xs.iter().any(|x| schema_match(x, c)) {
                return false;
            }
        }
        if s.get("uniqueItems") == Some(&Value::Bool(true)) {
            for (i, x) in xs.iter().enumerate() {
                if xs[..i].contains(x) {
                    return false;
                }
            }
        }
    }
    if let Some(text) = v.as_str() {
        let n = text.chars().count();
        if s.get("minLength")
            .and_then(Value::as_u64)
            .is_some_and(|x| n < (x as usize))
            || s.get("maxLength")
                .and_then(Value::as_u64)
                .is_some_and(|x| n > (x as usize))
        {
            return false;
        }
        if let Some(p) = s.get("pattern").and_then(Value::as_str) {
            if !frozen_pattern(text, p) {
                return false;
            }
        }
        match s.get("format").and_then(Value::as_str) {
            Some("date-time") if timestamp(text).is_err() => return false,
            Some("date")
                if text.len() != 10 || timestamp(&format!("{text}T00:00:00Z")).is_err() =>
            {
                return false
            }
            _ => {}
        }
    }
    if let Some(n) = v.as_f64() {
        if s.get("minimum")
            .and_then(Value::as_f64)
            .is_some_and(|m| n < m)
            || s.get("maximum")
                .and_then(Value::as_f64)
                .is_some_and(|m| n > m)
            || s.get("multipleOf")
                .and_then(Value::as_f64)
                .is_some_and(|m| n % m != 0.0)
        {
            return false;
        }
    }
    true
}
pub fn validate(e: &Value) -> Result<()> {
    let schema: Value = serde_json::from_str(SCHEMA).expect("frozen schema");
    if !schema_match(e, &schema) {
        return Err("v3_schema");
    }
    if canonical(e)?.len() > MAX_PUBLIC_BYTES {
        return Err("receipt_too_large");
    }
    if e["method_spec_sha256"] != method_hash() {
        return Err("method_hash_mismatch");
    }
    for k in ["seq", "supersedes_seq"] {
        if let Some(s) = e[k].as_str() {
            if s.parse::<u64>().is_err() {
                return Err("v3_sequence");
            }
        }
    }
    if e["seq"] == "0" {
        return Err("v3_sequence");
    }
    let a = timestamp(&format!(
        "{}T00:00:00Z",
        e["period_start"].as_str().ok_or("v3_period")?
    ))?;
    let b = timestamp(&format!(
        "{}T00:00:00Z",
        e["period_end"].as_str().ok_or("v3_period")?
    ))?;
    if a >= b {
        return Err("v3_period");
    }
    let checked = e["loans_checked"].as_str().ok_or("v3_count")?;
    if ["lt_5", "from_5_to_9", "unknown", "suppressed"].contains(&checked)
        && e["pledge_coverage_bps"]
            .as_u64()
            .is_some_and(|x| x % 2500 != 0)
    {
        return Err("v3_coverage");
    }
    for k in ["reported_nav", "trueval", "truerange_low", "truerange_high"] {
        if let Some(s) = e[k].as_str() {
            if s == "-0" || s.parse::<i128>().is_err() {
                return Err("v3_amount");
            }
        }
    }
    if e["supersedes_seq"].is_null() != e["correction_reason_code"].is_null() {
        return Err("v3_correction");
    }
    let sources = e["source_key_ids"].as_array().ok_or("v3_sources")?;
    let mut roles = BTreeSet::new();
    for row in sources {
        let role = row["source"].as_str().ok_or("v3_sources")?;
        let key = row["key_id"].as_str().ok_or("v3_sources")?;
        if !key.starts_with(&format!("{role}:")) || !roles.insert(role) {
            return Err("v3_sources");
        }
    }
    validate_signals(e)?;
    if envelope_hash(e)? != e["receipt_sha256"].as_str().ok_or("v3_hash")? {
        return Err("receipt_hash_mismatch");
    }
    Ok(())
}
pub fn validate_schema(value: &Value, schema: &Value) -> Result<()> {
    if schema_match(value, schema) {
        Ok(())
    } else {
        Err("schema_invalid")
    }
}

/// TEST ONLY, never enabled in the production/verifier/judge build.
#[cfg(feature = "dry-run-tests")]
pub fn validate_dry_run(e: &Value, explicit_dry_run: bool) -> Result<()> {
    if !explicit_dry_run {
        return validate(e);
    }
    let overlay: Value = serde_json::from_str(include_str!(
        "../../../receipts/tests/deploy-context.dryrun.json"
    ))
    .expect("TEST ONLY deployment overlay");
    if e["receipts_contract"] != overlay["receipts_contract"] || e["network"] != overlay["network"]
    {
        return Err("dry_run_context");
    }
    // Validate the sole permitted deployment substitution, then all normal frozen semantics.
    let mut schema: Value = serde_json::from_str(SCHEMA).expect("frozen schema");
    schema["properties"]["receipts_contract"]["const"] = overlay["receipts_contract"].clone();
    validate_schema(e, &schema)?;
    let mut normal = e.clone();
    normal["receipts_contract"] = Value::String("receipts.tnlab-718ca9.testnet".into());
    seal_envelope(&mut normal)?;
    validate(&normal)
}

/// Cross-field constraints additional to the frozen JSON shape.
pub fn validate_signals(e: &Value) -> Result<()> {
    let scored = e["status"] == "scored";
    let score = e["score"].as_u64();
    if scored != score.is_some() {
        return Err("v3_score_status");
    }
    let caps = e["caps"].as_array().ok_or("v3_caps")?;
    let holds = e["holds"].as_array().ok_or("v3_holds")?;
    if score.is_some_and(|n| !caps.is_empty() && n > 59) {
        return Err("v3_cap");
    }
    if let Some(n) = score {
        let expected = if n >= 85 {
            "green"
        } else if n >= 60 {
            "yellow"
        } else {
            "red"
        };
        let yellow = holds.iter().any(|h| {
            [
                "recent_pledge_attempt",
                "collection_pending",
                "collection_not_applicable",
            ]
            .iter()
            .any(|c| h == c)
        });
        if e["band"] != expected && !(expected == "green" && yellow && e["band"] == "yellow") {
            return Err("v3_band");
        }
        if yellow && n >= 85 && e["band"] == "green" {
            return Err("v3_hold");
        }
    }
    if e["source_key_ids"]
        .as_array()
        .ok_or("v3_sources")?
        .iter()
        .any(|s| s["sig_ok"] == false)
        && (!holds.contains(&Value::String("source_signature_invalid".into())) || scored)
    {
        return Err("v3_source_hold");
    }
    if holds.contains(&Value::String("second_lien_unsupported".into()))
        && e["pledge_result"] != "unknown"
    {
        return Err("v3_lien");
    }
    if let Some(t) = e["data_as_of"].as_str() {
        if timestamp(t)? > timestamp(e["valuation_time"].as_str().ok_or("v3_clock")?)? + 600000 {
            return Err("v3_clock");
        }
    }
    if e["pledge_scope"]["block_height"]
        .as_str()
        .ok_or("v3_block")?
        .parse::<u64>()
        .is_err()
    {
        return Err("v3_block");
    }
    Ok(())
}

/// Plain shortest decimal text for a private unrounded IEEE-754 score, without exponent or negative zero.
pub fn decimal(value: f64) -> Result<String> {
    let s = canonical(&Value::from(value))?;
    if s == "null" {
        return Err("decimal_nonfinite");
    }
    let Some((mantissa, exp)) = s.split_once('e') else {
        return Ok(s);
    };
    let exp: i32 = exp.parse().map_err(|_| "decimal_exponent")?;
    let sign = if mantissa.starts_with('-') { "-" } else { "" };
    let m = mantissa.trim_start_matches('-');
    let dot = m.find('.').unwrap_or(m.len()) as i32;
    let digits = m.replace('.', "");
    let pos = dot + exp;
    let result = if pos <= 0 {
        format!("{sign}0.{}{}", "0".repeat((-pos) as usize), digits)
    } else if pos as usize >= digits.len() {
        format!(
            "{sign}{}{}",
            digits,
            "0".repeat(pos as usize - digits.len())
        )
    } else {
        format!(
            "{sign}{}.{}",
            &digits[..pos as usize],
            &digits[pos as usize..]
        )
    };
    Ok(result)
}

#[cfg(test)]
mod pattern_tests {
    use super::*;
    #[test]
    fn every_frozen_schema_pattern_has_a_bounded_implementation() {
        for doc in [
            SCHEMA,
            include_str!("../../../schema/source-key-registry.schema.json"),
        ] {
            let s: Value = serde_json::from_str(doc).unwrap();
            fn walk(v: &Value) {
                match v {
                    Value::Object(m) => {
                        if let Some(p) = m.get("pattern").and_then(Value::as_str) {
                            let example = match p {
                                "^[0-9a-f]{64}$" => "a".repeat(64),
                                "^sha256:[0-9a-f]{64}$" => format!("sha256:{}", "a".repeat(64)),
                                "^ed25519:[0-9a-f]{64}$" => format!("ed25519:{}", "a".repeat(64)),
                                "^(0|[1-9][0-9]{0,19})$" => "1".into(),
                                "^-?(0|[1-9][0-9]{0,38})$" => "-1".into(),
                                "^[a-z0-9][a-z0-9._-]{0,62}[a-z0-9]$" => "fund.testnet".into(),
                                "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$" => {
                                    "2026-11-09T00:00:00Z".into()
                                }
                                _ => "servicer:sim:v1".into(),
                            };
                            assert!(frozen_pattern(&example, p), "unsupported frozen pattern");
                            assert!(!frozen_pattern(&(example + "\n"), p));
                        }
                        for x in m.values() {
                            walk(x)
                        }
                    }
                    Value::Array(a) => {
                        for x in a {
                            walk(x)
                        }
                    }
                    _ => {}
                }
            }
            walk(&s);
        }
        assert!(!frozen_pattern("anything", ".*"));
    }
}
