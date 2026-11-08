//! Shared building blocks, each a port of the JS reference: canonical JSON (cashflow/fixtures/canonical.mjs), dates
//! (cashflow/match.mjs `days`), round half up (spec/v2/score.mjs `rhu`), the JSON.stringify-equal compact form used
//! for snapshot hashes, and the pseudonymizer (cashflow/pseudo.mjs).
use hmac::{Hmac, Mac};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

pub type R<T> = Result<T, String>;
pub const MAX_SAFE: i64 = 9_007_199_254_740_991;

pub fn safe(x: i64, what: &str) -> R<i64> {
    if x.abs() > MAX_SAFE {
        return Err(format!("{what} must be a safe integer"));
    }
    Ok(x)
}

/// round(a / b) half up, for integers a >= 0, b > 0 (spec section 10).
pub fn rhu(a: i64, b: i64) -> R<i64> {
    if a.abs() > MAX_SAFE || b.abs() > MAX_SAFE || a < 0 || b <= 0 {
        return Err(format!("rhu: bad operands {a} / {b}"));
    }
    let q = a / b;
    Ok(if 2 * (a - q * b) >= b { q + 1 } else { q })
}

/// Days since 1970-01-01 for a strict YYYY-MM-DD date (UTC).
pub fn days(iso: &str) -> R<i64> {
    let b = iso.as_bytes();
    let ok = b.len() == 10 && b[4] == b'-' && b[7] == b'-' && b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit());
    if !ok {
        return Err(format!("bad date {iso}"));
    }
    let y: i64 = iso[0..4].parse().unwrap();
    let m: i64 = iso[5..7].parse().unwrap();
    let d: i64 = iso[8..10].parse().unwrap();
    if !(1..=12).contains(&m) || d < 1 || d > month_len(y, m) {
        return Err(format!("bad date {iso}"));
    }
    Ok(days_from_civil(y, m, d))
}

pub fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}
pub fn month_len(y: i64, m: i64) -> i64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ => {
            if is_leap(y) {
                29
            } else {
                28
            }
        }
    }
}
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}
pub fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// The reference toUtc (cashflow/run.mjs): "YYYY-MM-DD" (midnight UTC) or "YYYY-MM-DDTHH:MM:SS[.mmm]" with "Z" or a
/// "+HH:MM" / "-HH:MM" offset, normalized to "YYYY-MM-DDTHH:MM:SS[.mmm]Z" (milliseconds only when not zero), years
/// 1970 to 9999 after normalizing. Anything else is None.
pub fn to_utc(x: &str) -> Option<String> {
    let full;
    let s = if x.len() == 10 {
        full = format!("{x}T00:00:00Z");
        full.as_str()
    } else {
        x
    };
    let b = s.as_bytes();
    let digits = |a: usize, n: usize| -> Option<i64> {
        let t = s.get(a..a + n)?;
        if t.bytes().all(|c| c.is_ascii_digit()) {
            t.parse().ok()
        } else {
            None
        }
    };
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let (y, mo, d, h, mi, se) = (digits(0, 4)?, digits(5, 2)?, digits(8, 2)?, digits(11, 2)?, digits(14, 2)?, digits(17, 2)?);
    let (ms, rest) = if b[19] == b'.' { (digits(20, 3)?, &s[23..]) } else { (0, &s[19..]) };
    let off = match rest.as_bytes() {
        [b'Z'] => 0,
        [sign @ (b'+' | b'-'), _, _, b':', _, _] => {
            let (oh, om) = (digits(s.len() - 5, 2)?, digits(s.len() - 2, 2)?);
            if oh > 23 || om > 59 {
                return None;
            }
            (if *sign == b'-' { -1 } else { 1 }) * (oh * 60 + om)
        }
        _ => return None,
    };
    if !(1..=12).contains(&mo) || d < 1 || d > month_len(y, mo) || h > 23 || mi > 59 || se > 59 {
        return None;
    }
    let utc = days_from_civil(y, mo, d) * 86_400_000 + h * 3_600_000 + mi * 60_000 + se * 1000 + ms - off * 60_000;
    if utc < 0 || utc >= days_from_civil(10000, 1, 1) * 86_400_000 {
        return None;
    }
    let (yy, mm, dd) = civil_from_days(utc.div_euclid(86_400_000));
    let t = utc.rem_euclid(86_400_000);
    let (th, tm, ts, tms) = (t / 3_600_000, (t / 60_000) % 60, (t / 1000) % 60, t % 1000);
    Some(if tms == 0 { format!("{yy:04}-{mm:02}-{dd:02}T{th:02}:{tm:02}:{ts:02}Z") } else { format!("{yy:04}-{mm:02}-{dd:02}T{th:02}:{tm:02}:{ts:02}.{tms:03}Z") })
}

/// Milliseconds since the epoch for "YYYY-MM-DDTHH:MM:SSZ" or "YYYY-MM-DDTHH:MM:SS.sssZ" (what the reference uses).
pub fn parse_ts(s: &str) -> R<i64> {
    let bad = || format!("bad timestamp {s}");
    if s.len() < 20 || !s.ends_with('Z') || &s[10..11] != "T" || &s[13..14] != ":" || &s[16..17] != ":" {
        return Err(bad());
    }
    let day = days(&s[0..10]).map_err(|_| bad())?;
    let num = |a: usize, b: usize| s.get(a..b).and_then(|x| if x.bytes().all(|c| c.is_ascii_digit()) { x.parse::<i64>().ok() } else { None }).ok_or_else(bad);
    let (h, mi, se) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    let ms = match &s[19..s.len() - 1] {
        "" => 0,
        f if f.len() == 4 && f.starts_with('.') => num(20, 23)?,
        _ => return Err(bad()),
    };
    if h > 23 || mi > 59 || se > 59 {
        return Err(bad());
    }
    Ok(day * 86_400_000 + h * 3_600_000 + mi * 60_000 + se * 1000 + ms)
}

/// Math.max(0, Math.round((to - from) / 3600000)) for two timestamps.
pub fn hours_between(from: &str, to: &str) -> R<i64> {
    let ms = parse_ts(to)? - parse_ts(from)?;
    Ok(if ms <= 0 { 0 } else { (ms + 1_800_000).div_euclid(3_600_000) })
}

/// JSON.stringify for one string.
pub fn js_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn number(v: &Value, out: &mut String) -> R<()> {
    match v.as_i64() {
        Some(i) if i.abs() <= MAX_SAFE => {
            out.push_str(&i.to_string());
            Ok(())
        }
        _ => Err(format!("only safe integers are allowed, got {v}")),
    }
}

/// Canonical JSON: keys sorted (UTF-16 code units) at every level, no whitespace, safe integers only.
pub fn canonical(v: &Value) -> R<String> {
    let mut out = String::new();
    canon_into(v, &mut out)?;
    Ok(out)
}
fn canon_into(v: &Value, out: &mut String) -> R<()> {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(_) => number(v, out)?,
        Value::String(s) => js_string(s, out),
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                canon_into(x, out)?;
            }
            out.push(']');
        }
        Value::Object(o) => {
            let mut keys: Vec<&String> = o.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                js_string(k, out);
                out.push(':');
                canon_into(&o[k.as_str()], out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

/// JSON.stringify(value) with the keys in their original order (the reference hashes source documents this way).
pub fn js_stringify(v: &Value) -> R<String> {
    let mut out = String::new();
    stringify_into(v, &mut out)?;
    Ok(out)
}
fn stringify_into(v: &Value, out: &mut String) -> R<()> {
    match v {
        Value::Object(o) => {
            out.push('{');
            for (i, (k, x)) in o.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                js_string(k, out);
                out.push(':');
                stringify_into(x, out)?;
            }
            out.push('}');
        }
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                stringify_into(x, out)?;
            }
            out.push(']');
        }
        _ => canon_into(v, out)?,
    }
    Ok(())
}

pub fn sha256_hex(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

/// Keyed pseudonyms (cashflow/pseudo.mjs): the first 16 bytes, as hex, of a MAC over "truenav-ref-v1|<domain>|<id>".
pub trait Pseudonymizer {
    fn mac32(&self, msg: &[u8]) -> R<Vec<u8>>;
    fn r#ref(&self, domain: &str, id: &str) -> R<String> {
        if domain.is_empty() || !domain.bytes().all(|c| c.is_ascii_lowercase() || c == b'_') {
            return Err("bad domain".into());
        }
        let tag = self.mac32(format!("truenav-ref-v1|{domain}|{}", id.trim()).as_bytes())?;
        if tag.len() != 32 {
            return Err(format!("MAC output must be 32 bytes, got {}", tag.len()));
        }
        Ok(hex::encode(&tag)[..32].to_string())
    }
    fn unit_ref(&self, id: &str) -> R<String> {
        self.r#ref("unit", id)
    }
    fn payer_ref(&self, name: &str) -> R<String> {
        let upper = name.to_uppercase();
        let mut collapsed = String::with_capacity(upper.len());
        let mut in_ws = false;
        for c in upper.chars() {
            if c.is_whitespace() {
                if !in_ws {
                    collapsed.push(' ');
                }
                in_ws = true;
            } else {
                collapsed.push(c);
                in_ws = false;
            }
        }
        self.r#ref("payer", &collapsed)
    }
}

/// HMAC-SHA256 under a known seed: the JS reference and the parity fixtures.
pub struct SeedPseudonymizer(pub Vec<u8>);
impl Pseudonymizer for SeedPseudonymizer {
    fn mac32(&self, msg: &[u8]) -> R<Vec<u8>> {
        if self.0.len() < 16 {
            return Err("pseudonym key must be at least 16 bytes".into());
        }
        let mut m = Hmac::<Sha256>::new_from_slice(&self.0).map_err(|e| e.to_string())?;
        m.update(msg);
        Ok(m.finalize().into_bytes().to_vec())
    }
}

/// Helpers for reading the reference's loosely typed JSON exactly the way the JS does.
pub fn obj<'a>(v: &'a Value, what: &str) -> R<&'a Map<String, Value>> {
    v.as_object().ok_or_else(|| format!("{what} must be an object"))
}
pub fn arr<'a>(v: &'a Value, key: &str) -> R<&'a Vec<Value>> {
    v.get(key).and_then(Value::as_array).ok_or_else(|| format!("{key} must be an array"))
}
pub fn s(v: &Value, key: &str) -> R<String> {
    match v.get(key) {
        Some(Value::String(x)) => Ok(x.clone()),
        Some(Value::Number(n)) => Ok(n.to_string()),
        _ => Err(format!("{key} must be a string")),
    }
}
/// A JS truthy string field: missing, null, false and "" are None.
pub fn opt_s(v: &Value, key: &str) -> Option<String> {
    match v.get(key) {
        Some(Value::String(x)) if !x.is_empty() => Some(x.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    }
}
pub fn int(v: &Value, key: &str) -> R<i64> {
    match v.get(key).and_then(Value::as_i64) {
        Some(x) => safe(x, key),
        None => Err(format!("{key} must be integer cents")),
    }
}
/// `issuer.x || 0`
pub fn int_or0(v: &Value, key: &str) -> R<i64> {
    match v.get(key) {
        None | Some(Value::Null) => Ok(0),
        Some(x) => x.as_i64().map(|i| safe(i, key)).unwrap_or_else(|| Err(format!("{key} must be an integer"))),
    }
}
pub fn truthy(v: &Value, key: &str) -> bool {
    match v.get(key) {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::String(x)) => !x.is_empty(),
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0).unwrap_or(true),
        Some(_) => true,
    }
}
