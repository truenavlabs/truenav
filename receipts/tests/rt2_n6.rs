// RT2 red team (local, not committed). N6: stamp_failure (lib.rs:950) skips stamping when the head's stored text
// contains the substring "head_status":"failed" anywhere. Reachability check for v3: can a body that is not a
// failed head carry that substring and still pass the v3 validator that accept_v3 runs before storing?
use near_sdk::serde_json::{self, json, Value};

fn golden() -> Vec<Value> {
    let v: Value = serde_json::from_str(include_str!("../../schema/vectors/receipt-v3-golden.json")).unwrap();
    v["vectors"].as_array().unwrap().iter().map(|x| x["envelope"].clone()).collect()
}
fn paths(v: &Value, here: Vec<String>, out: &mut Vec<Vec<String>>) {
    match v {
        Value::Object(m) => {
            out.push(here.clone());
            for (k, x) in m { let mut p = here.clone(); p.push(k.clone()); paths(x, p, out); }
        }
        Value::Array(a) => for (i, x) in a.iter().enumerate() { let mut p = here.clone(); p.push(i.to_string()); paths(x, p, out); },
        _ => {}
    }
}
fn at<'a>(v: &'a mut Value, p: &[String]) -> &'a mut Value {
    p.iter().fold(v, |v, k| if v.is_array() { &mut v[k.parse::<usize>().unwrap()] } else { &mut v[k.as_str()] })
}

#[test]
fn rt2_n6_v3_validator_rejects_a_head_status_key_in_every_object() {
    let mut checked = 0;
    for e in golden() {
        assert!(truenav_v3_core::validate(&e).is_ok(), "control: golden vector validates");
        let mut ps = vec![];
        paths(&e, vec![], &mut ps);
        for p in ps {
            let mut m = e.clone();
            at(&mut m, &p).as_object_mut().unwrap().insert("head_status".into(), json!("failed"));
            assert!(serde_json::to_string(&m).unwrap().contains("\"head_status\":\"failed\""));
            assert!(truenav_v3_core::validate(&m).is_err(), "object at {p:?} accepted a head_status key");
            checked += 1;
        }
    }
    assert!(checked > 10, "checked {checked} objects");
}

#[test]
fn rt2_n6_escaped_text_cannot_form_the_substring() {
    // inside a JSON string value the quotes are escaped, so the raw substring cannot appear there
    let s = serde_json::to_string(&json!({"exceptions": ["\"head_status\":\"failed\""]})).unwrap();
    assert!(!s.contains("\"head_status\":\"failed\""), "{s}");
}
