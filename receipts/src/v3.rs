//! Versioned sidecar state leaves the v2 Borsh layout and all historical receipt bytes intact.
use crate::*;
#[cfg(not(feature = "dry-run-tests"))]
use truenav_v3_core::validate as validate_v3;
use truenav_v3_core::{canonical, timestamp};
const MIGRATED: &[u8] = b"truenav:v3:migrated";
pub fn enabled() -> bool {
    env::storage_has_key(MIGRATED)
}
pub(crate) fn clear_context(id: u64) {
    env::storage_remove(&key(b"pending:", &id.to_string()));
}
fn key(prefix: &[u8], token: &str) -> Vec<u8> {
    [b"truenav:v3:".as_slice(), prefix, token.as_bytes()].concat()
}
fn read(key: &[u8]) -> Option<Value> {
    env::storage_read(key).and_then(|b| serde_json::from_slice(&b).ok())
}
fn write(key: &[u8], v: &Value) {
    env::storage_write(key, &serde_json::to_vec(v).expect("v3 serialization"));
}
fn iso(ns: u64) -> String {
    let secs = ns / 1_000_000_000;
    let z = (secs / 86400) as i64 + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    y += i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        secs / 3600 % 24,
        secs / 60 % 60,
        secs % 60
    )
}
#[near(serializers=[json])]
#[derive(Clone)]
pub struct FundContext {
    pub fund_account: AccountId,
    pub period_start: String,
    pub period_end: String,
    /// Pinned benchmark time only. None uses the TEE's real clock.
    pub judge_valuation_time: Option<String>,
    pub source_registry_sha256: String,
    pub supersedes_seq: Option<String>,
    pub correction_reason_code: Option<String>,
}
#[near]
impl Receipts {
    /// Called by the contract account in the separately approved deploy/migrate batch. No old state is rewritten.
    #[init(ignore_state)]
    #[private]
    pub fn migrate_v3() -> Self {
        require!(!enabled(), "already migrated");
        let state: Self = env::state_read().expect("v2 state missing");
        require!(state.paused, "pause before migration");
        require!(
            state
                .tokens
                .values()
                .all(|t| state.pending.get(&t.token_id).is_none()),
            "drain pending runs before migration"
        );
        env::storage_write(MIGRATED, b"3");
        state
    }
    /// Bind an existing or new credit token to a fund and a run period. Admin calls cost exactly one yocto.
    #[payable]
    pub fn configure_v3_fund(&mut self, token_id: String, context: FundContext) {
        self.only_admin();
        require!(enabled(), "migrate first");
        require!(self.paused, "pause before changing run context");
        require!(
            !token_id.is_empty()
                && token_id.len() <= 128
                && token_id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'),
            "invalid token_id"
        );
        require!(self.pending.get(&token_id).is_none(), "run pending");
        require!(
            context.source_registry_sha256.len() == 64
                && context
                    .source_registry_sha256
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "invalid source registry hash"
        );
        let start =
            timestamp(&format!("{}T00:00:00Z", context.period_start)).expect("invalid period");
        let end = timestamp(&format!("{}T00:00:00Z", context.period_end)).expect("invalid period");
        require!(start < end, "invalid period");
        if let Some(t) = &context.judge_valuation_time {
            timestamp(t).expect("invalid judge time");
        }
        require!(
            context.supersedes_seq.is_none() == context.correction_reason_code.is_none(),
            "correction pair required"
        );
        if let Some(seq) = &context.supersedes_seq {
            require!(
                seq.parse::<u64>().is_ok() && seq != "0",
                "invalid supersedes"
            );
            require!(
                [
                    "source_correction",
                    "calculation_correction",
                    "coverage_correction"
                ]
                .contains(&context.correction_reason_code.as_deref().unwrap_or("")),
                "invalid correction reason"
            );
        }
        if let Some(t) = self.tokens.get(&token_id) {
            require!(t.kind == "credit", "v3 accepts credit only");
        } else {
            self.tokens.insert(
                token_id.clone(),
                TokenInfo {
                    token_id: token_id.clone(),
                    kind: "credit".into(),
                    receipts: 0,
                    registered_ns: env::block_timestamp(),
                },
            );
        }
        if let Some(previous) = read(&key(b"fund:", &token_id)) {
            require!(
                previous["fund_account"] == context.fund_account.as_str(),
                "fund binding immutable"
            );
        }
        write(
            &key(b"fund:", &token_id),
            &serde_json::to_value(context).expect("fund context"),
        );
    }
    pub fn get_first_v3_seq(&self, token_id: String) -> Option<String> {
        read(&key(b"first:", &token_id)).and_then(|v| v.as_str().map(str::to_string))
    }
    pub fn get_latest_receipt(&self, token_id: String) -> Option<Value> {
        let r = self.get_latest(token_id)?;
        if r.method != "truenav-v3.0.0" {
            return None;
        }
        serde_json::from_str(&r.receipt).ok()
    }
    /// Inclusive ascending history. Every entry has an explicit version tag, including historical v2 wrappers.
    pub fn get_receipt_history(
        &self,
        token_id: String,
        from_seq: Option<String>,
        limit: Option<u64>,
    ) -> Vec<Value> {
        let Some(t) = self.tokens.get(&token_id) else {
            return vec![];
        };
        let start = from_seq
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(1)
            .max(1);
        let end = start
            .saturating_add(limit.unwrap_or(20).min(100))
            .min(t.receipts.saturating_add(1));
        (start..end)
            .filter_map(|seq| self.get_receipt(token_id.clone(), seq))
            .collect()
    }
    pub fn list_funds(&self, from: Option<u64>, limit: Option<u64>) -> Vec<Value> {
        self.tokens.values().filter_map(|t|read(&key(b"fund:",&t.token_id)).map(|c|json!({"token_id":t.token_id,"fund_account":c["fund_account"],"kind":t.kind,"latest_seq":t.receipts.to_string(),"first_v3_seq":self.get_first_v3_seq(t.token_id.clone())}))).skip(from.unwrap_or(0)as usize).take(limit.unwrap_or(50).min(100)as usize).collect()
    }
}
impl Receipts {
    pub(crate) fn reserve_v3(&mut self, p: &Pending) {
        require!(enabled(), "migrate first");
        let c = read(&key(b"fund:", &p.token_id)).expect("configure v3 fund first");
        let seq = self
            .tokens
            .get(&p.token_id)
            .expect("token")
            .receipts
            .checked_add(1)
            .expect("sequence exhausted");
        let prev = self
            .get_latest(p.token_id.clone())
            .map(|r| r.receipt_sha256);
        let ctx = json!({"network":"near_testnet","receipts_contract":env::current_account_id(),"token_id":p.token_id,"fund_account":c["fund_account"],"period_start":c["period_start"],"period_end":c["period_end"],"seq":seq.to_string(),"prev_receipt_sha256":prev,"supersedes_seq":c["supersedes_seq"],"correction_reason_code":c["correction_reason_code"],"request_id":p.request_id.to_string(),"request_nonce":p.run_nonce,"engine_version_key":p.version_key,"engine_code_sha256":p.version_key,"judge_valuation_time":c["judge_valuation_time"],"source_registry_sha256":c["source_registry_sha256"]});
        write(&key(b"pending:", &p.request_id.to_string()), &ctx);
    }
    pub(crate) fn v3_run_input(&self, token: &str, nonce: &str) -> Value {
        let Some(p) = self.pending.get(token) else {
            return json!({"receipt_version":"3","status":"no_pending_request"});
        };
        let mut c =
            read(&key(b"pending:", &p.request_id.to_string())).expect("v3 pending context missing");
        c["request_nonce"] = json!(nonce);
        let previous=self.get_latest(token.to_string()).map(|r|if r.method=="truenav-v3.0.0"{serde_json::from_str::<Value>(&r.receipt).expect("stored v3")}else{let v:Value=serde_json::from_str(&r.receipt).expect("stored v2");json!({"receipt_version":"2","receipt_sha256":r.receipt_sha256,"period":r.period,"passport":v["passport"]})});
        json!({"receipt_version":"3","context":c,"previous_receipt":previous})
    }
    pub(crate) fn accept_v3(&mut self, p: &Pending, body: &Value) -> Result<u64, String> {
        let err = |s: &str| s.to_string();
        if !enabled() {
            return Err(err("v3_not_migrated"));
        }
        let ctx = read(&key(b"pending:", &p.request_id.to_string()))
            .ok_or_else(|| err("v3_context_missing"))?;
        if [
            "receipt_sha256",
            "attestation_status",
            "attestation_ref",
            "issued_at",
        ]
        .iter()
        .any(|k| body.get(k).is_some())
        {
            return Err(err("v3_execution_shape"));
        }
        let mut envelope = body.clone();
        if !envelope.is_object() {
            return Err(err("v3_execution_shape"));
        }
        envelope["attestation_ref"] = Value::Null;
        envelope["issued_at"] = json!(iso(env::block_timestamp()));
        truenav_v3_core::wire::seal_envelope(&mut envelope).map_err(err)?;
        #[cfg(not(feature = "dry-run-tests"))]
        validate_v3(&envelope).map_err(err)?;
        #[cfg(feature = "dry-run-tests")]
        {
            if envelope["receipts_contract"] == "receipts.tnlab-718ca9.testnet" {
                truenav_v3_core::validate(&envelope).map_err(err)?;
            } else {
                env::log_str("DRY_RUN TEST ONLY validator");
                truenav_v3_core::wire::validate_dry_run(&envelope, true).map_err(err)?;
            }
        }
        for name in [
            "network",
            "receipts_contract",
            "token_id",
            "fund_account",
            "period_start",
            "period_end",
            "seq",
            "prev_receipt_sha256",
            "supersedes_seq",
            "correction_reason_code",
            "request_id",
            "request_nonce",
            "engine_version_key",
            "engine_code_sha256",
        ] {
            if envelope[name] != ctx[name] {
                return Err(err("v3_context_mismatch"));
            }
        }
        let now = env::block_timestamp() / 1_000_000;
        let valuation = timestamp(
            envelope["valuation_time"]
                .as_str()
                .ok_or_else(|| err("v3_clock"))?,
        )
        .map_err(err)?;
        if let Some(pinned) = ctx["judge_valuation_time"].as_str() {
            if envelope["valuation_time"] != pinned {
                return Err(err("v3_judge_clock"));
            }
        } else if valuation < 0
            || valuation as u64 > now.saturating_add(600000)
            || (valuation as u64) < p.requested_ns / 1_000_000
        {
            return Err(err("v3_clock"));
        }
        let mut token = self
            .tokens
            .get(&p.token_id)
            .cloned()
            .ok_or_else(|| err("unknown_token"))?;
        let seq = token
            .receipts
            .checked_add(1)
            .ok_or_else(|| err("sequence_exhausted"))?;
        if envelope["seq"].as_str().and_then(|s| s.parse::<u64>().ok()) != Some(seq)
            || envelope["prev_receipt_sha256"]
                != json!(self
                    .get_latest(p.token_id.clone())
                    .map(|r| r.receipt_sha256))
        {
            return Err(err("v3_chain_mismatch"));
        }
        let period_key = key(
            b"period:",
            &format!(
                "{}:{}:{}",
                p.token_id,
                envelope["period_start"].as_str().unwrap(),
                envelope["period_end"].as_str().unwrap()
            ),
        );
        let old_period = read(&period_key).and_then(|v| v.as_str().map(str::to_string));
        match (old_period, envelope["supersedes_seq"].as_str()) {
            (None, None) => {}
            (Some(old), Some(s)) if old == s => {}
            _ => return Err(err("v3_correction_invalid")),
        }
        let receipt = canonical(&envelope).map_err(err)?;
        let caps = envelope["caps"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        let holds = envelope["holds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        let r = StoredReceipt {
            token_id: p.token_id.clone(),
            seq,
            request_id: p.request_id,
            method: p.method.clone(),
            version_key: p.version_key.clone(),
            score: envelope["score"].as_u64().unwrap_or(0),
            band: envelope["band"].as_str().unwrap().into(),
            period: format!(
                "{}/{}",
                envelope["period_start"].as_str().unwrap(),
                envelope["period_end"].as_str().unwrap()
            ),
            as_of: envelope["valuation_time"].as_str().unwrap().into(),
            caps,
            holds,
            receipt_sha256: envelope["receipt_sha256"].as_str().unwrap().into(),
            receipt,
            requested_ns: p.requested_ns,
            stored_ns: env::block_timestamp(),
            block_height: env::block_height(),
        };
        emit(
            "receipt_stored",
            json!({"receipt_version":"3","token_id":p.token_id,"seq":seq.to_string(),"receipt_sha256":r.receipt_sha256}),
        );
        self.receipts.insert((p.token_id.clone(), seq), r);
        token.receipts = seq;
        self.tokens.insert(p.token_id.clone(), token);
        self.failures.remove(&p.token_id);
        if !env::storage_has_key(&key(b"first:", &p.token_id)) {
            write(&key(b"first:", &p.token_id), &json!(seq.to_string()));
        }
        write(&period_key, &json!(seq.to_string()));
        env::storage_remove(&key(b"pending:", &p.request_id.to_string()));
        Ok(seq)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::{test_utils::VMContextBuilder, testing_env};
    use truenav_v3_core::hash;
    fn account(s: &str) -> AccountId {
        s.parse().unwrap()
    }
    fn context(who: &str, at: u64) {
        let mut c = VMContextBuilder::new();
        c.current_account_id(account("receipts.tnlab-718ca9.testnet"))
            .predecessor_account_id(account(who))
            .signer_account_id(account(who))
            .attached_deposit(NearToken::from_yoctonear(1))
            .block_timestamp(at)
            .prepaid_gas(Gas::from_tgas(300))
            .account_balance(NearToken::from_near(100));
        testing_env!(c.build());
    }
    fn setup() -> Receipts {
        context("admin.testnet", 1);
        Receipts::new(
            account("admin.testnet"),
            account("pauser.testnet"),
            Config {
                outlayer: account("outlayer.testnet"),
                project_id: "TEST".into(),
                version_key: "0".repeat(64),
                method: "cashflow-v2.1.0".into(),
                secrets_profile: "TEST".into(),
                secrets_owner: account("admin.testnet"),
                max_instructions: 1_000_000_000,
                max_memory_mb: 128,
                max_execution_seconds: 30,
                outlayer_deposit: U128(0),
                storage_deposit: U128(NearToken::from_near(1).as_yoctonear()),
                outlayer_tgas: 200,
                callback_tgas: 80,
            },
        )
    }
    fn migrated() -> Receipts {
        let mut c = setup();
        c.pause();
        c.flush_all();
        env::state_write(&c);
        drop(c);
        context("receipts.tnlab-718ca9.testnet", 1);
        Receipts::migrate_v3()
    }
    fn golden() -> Value {
        let v: Value =
            serde_json::from_str(include_str!("../../schema/vectors/receipt-v3-golden.json"))
                .unwrap();
        v["vectors"][0]["envelope"].clone()
    }
    fn pending(c: &mut Receipts, e: &Value) -> Pending {
        let token = e["token_id"].as_str().unwrap().to_string();
        if c.tokens.get(&token).is_none() {
            c.tokens.insert(
                token.clone(),
                TokenInfo {
                    token_id: token.clone(),
                    kind: "credit".into(),
                    receipts: 0,
                    registered_ns: 1,
                },
            );
        }
        let p = Pending {
            request_id: 1,
            token_id: token,
            run_nonce: e["request_nonce"].as_str().unwrap().into(),
            requester: account("runner.testnet"),
            version_key: e["engine_version_key"].as_str().unwrap().into(),
            method: "truenav-v3.0.0".into(),
            storage_deposit: U128(1),
            outlayer_deposit: U128(0),
            pending_bytes: 0,
            requested_ns: 1,
        };
        let mut ctx = e.clone();
        ctx["judge_valuation_time"] = e["valuation_time"].clone();
        write(&key(b"pending:", "1"), &ctx);
        p
    }
    fn body(e: &Value) -> Value {
        let mut b = e.clone();
        for k in ["receipt_sha256", "attestation_ref", "issued_at"] {
            b.as_object_mut().unwrap().remove(k);
        }
        b
    }
    #[test]
    fn migration_preserves_v2_bytes_and_tags_history() {
        let mut c = setup();
        c.register_token("DEMO-CREDIT".into(), "credit".into());
        let fixture: Value =
            serde_json::from_str(include_str!("../tests/fixtures/engine-receipts.json")).unwrap();
        let raw = fixture["receipts"]["DEMO-CREDIT"]["output"]
            .as_str()
            .unwrap()
            .to_string();
        let r = StoredReceipt {
            token_id: "DEMO-CREDIT".into(),
            seq: 1,
            request_id: 1,
            method: "cashflow-v2.1.0".into(),
            version_key: "0".repeat(64),
            score: 58,
            band: "red".into(),
            period: "2026-10".into(),
            as_of: "2026-11-09T00:00:00Z".into(),
            caps: vec![],
            holds: vec![],
            receipt_sha256: hash(raw.as_bytes()),
            receipt: raw.clone(),
            requested_ns: 1,
            stored_ns: 2,
            block_height: 3,
        };
        c.receipts.insert(("DEMO-CREDIT".into(), 1), r.clone());
        c.tokens.get_mut("DEMO-CREDIT").unwrap().receipts = 1;
        c.pause();
        c.flush_all();
        env::state_write(&c);
        drop(c);
        context("receipts.tnlab-718ca9.testnet", 1);
        let c = Receipts::migrate_v3();
        let old = c.get_latest("DEMO-CREDIT".into()).unwrap();
        assert_eq!(old, r);
        assert_eq!(old.receipt.as_bytes(), raw.as_bytes());
        let mut tagged = c.get_receipt("DEMO-CREDIT".into(), 1).unwrap();
        assert_eq!(
            tagged.as_object_mut().unwrap().remove("receipt_version"),
            Some(json!("2"))
        );
        assert_eq!(tagged, serde_json::to_value(r).unwrap());
        assert!(c.get_first_v3_seq("DEMO-CREDIT".into()).is_none());
        assert!(c.get_receipt("DEMO-CREDIT".into(), 999).is_none());
        let mut c = c;
        let mut e = golden();
        e["token_id"] = json!("DEMO-CREDIT");
        e["seq"] = json!("2");
        e["prev_receipt_sha256"] = json!(old.receipt_sha256);
        let p = pending(&mut c, &e);
        context(
            "receipts.tnlab-718ca9.testnet",
            timestamp(e["issued_at"].as_str().unwrap()).unwrap() as u64 * 1_000_000,
        );
        assert_eq!(c.accept_v3(&p, &body(&e)), Ok(2));
        assert_eq!(c.get_first_v3_seq("DEMO-CREDIT".into()), Some("2".into()));
        assert_eq!(
            c.get_receipt("DEMO-CREDIT".into(), 1).unwrap()["receipt_version"],
            "2"
        );
        assert_eq!(
            c.get_receipt("DEMO-CREDIT".into(), 2).unwrap()["prev_receipt_sha256"],
            old.receipt_sha256
        );
    }
    #[test]
    fn full_v3_read_matches_frozen_golden_and_unknown_is_null() {
        let mut c = migrated();
        let e = golden();
        let p = pending(&mut c, &e);
        context(
            "receipts.tnlab-718ca9.testnet",
            timestamp(e["issued_at"].as_str().unwrap()).unwrap() as u64 * 1_000_000,
        );
        assert_eq!(c.accept_v3(&p, &body(&e)).unwrap(), 1);
        assert_eq!(c.get_receipt(p.token_id.clone(), 1).unwrap(), e);
        assert_eq!(c.get_latest_receipt(p.token_id.clone()).unwrap(), e);
        assert_eq!(c.get_first_v3_seq(p.token_id.clone()), Some("1".into()));
        assert!(c.get_receipt(p.token_id, 2).is_none());
    }
    #[test]
    fn duplicate_period_requires_a_correction_and_chain_must_match() {
        let mut c = migrated();
        let mut e = golden();
        let p = pending(&mut c, &e);
        context(
            "receipts.tnlab-718ca9.testnet",
            timestamp(e["issued_at"].as_str().unwrap()).unwrap() as u64 * 1_000_000,
        );
        c.accept_v3(&p, &body(&e)).unwrap();
        e["seq"] = json!("2");
        e["prev_receipt_sha256"] = e["receipt_sha256"].clone();
        let p = pending(&mut c, &e);
        assert_eq!(
            c.accept_v3(&p, &body(&e)),
            Err("v3_correction_invalid".into())
        );
        e["supersedes_seq"] = json!("1");
        e["correction_reason_code"] = json!("source_correction");
        let p = pending(&mut c, &e);
        assert_eq!(c.accept_v3(&p, &body(&e)), Ok(2));
        let head = c.get_latest_receipt(p.token_id.clone()).unwrap();
        assert_eq!(head["supersedes_seq"], "1");
        assert_eq!(
            c.get_receipt_history(p.token_id, Some("1".into()), Some(100))
                .len(),
            2
        );
    }
    #[test]
    fn v3_whitelist_rejects_the_demo_credit_reconstruction_inputs() {
        let mut c = migrated();
        let e = golden();
        let p = pending(&mut c, &e);
        context(
            "receipts.tnlab-718ca9.testnet",
            timestamp(e["issued_at"].as_str().unwrap()).unwrap() as u64 * 1_000_000,
        );
        let mut b = body(&e);
        b["metrics"] =
            json!({"late_share_bps":1500,"cohorts":{"current":{"principal_cents":850000000}}});
        assert_eq!(c.accept_v3(&p, &b), Err("v3_schema".into()));
        let p = pending(&mut c, &e);
        assert_eq!(c.accept_v3(&p, &body(&e)), Ok(1));
        let public = c.get_latest_receipt(p.token_id).unwrap();
        let raw = canonical(&public).unwrap();
        assert!(!raw.contains("principal_cents"));
        assert!(!raw.contains("late_share_bps"));
        assert!(!raw.contains("claimed_not_settled_cents"));
    }
    #[test]
    #[should_panic(expected = "pause before migration")]
    fn migration_requires_pause() {
        let c = setup();
        env::state_write(&c);
        context("receipts.tnlab-718ca9.testnet", 1);
        let _ = Receipts::migrate_v3();
    }
    #[test]
    #[should_panic(expected = "v3 migration forbids v2 writes")]
    fn migration_never_reenables_the_old_leaking_writer() {
        let mut c = migrated();
        context("admin.testnet", 1);
        let config = c.config.clone();
        c.set_config(config);
    }
}
