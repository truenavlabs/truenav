//! Testnet-only, view-only RPC adapter. Every query is bound to one finalized block hash.
use crate::engine::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use truenav_v3_core::source::Scope;
use truenav_v3_core::{parse, Result};
pub trait Transport {
    fn post_json(&self, body: &Value) -> Result<Value>;
}
pub struct NearViews<'a> {
    pub transport: &'a dyn Transport,
    pub height: String,
    pub block_hash: String,
}
impl<'a> NearViews<'a> {
    pub fn finalized(t: &'a dyn Transport) -> Result<Self> {
        let r=t.post_json(&json!({"jsonrpc":"2.0","id":"truenav-v3-read","method":"block","params":{"finality":"final"}}))?;
        let h = r["result"]["header"]["height"]
            .as_u64()
            .ok_or("registry_block")?;
        let hash = r["result"]["header"]["hash"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("registry_block")?;
        Ok(Self {
            transport: t,
            height: h.to_string(),
            block_hash: hash.into(),
        })
    }
    pub fn view(&self, method: &str, args: Value) -> Result<Value> {
        if ![
            "get_fund",
            "get_lock",
            "get_attempts_page",
            "get_certificate_count",
            "get_certificate_history_page",
            "get_latest_certificate",
        ]
        .contains(&method)
        {
            return Err("rpc_view_method");
        }
        let r=self.transport.post_json(&json!({"jsonrpc":"2.0","id":"truenav-v3-read","method":"query","params":{"request_type":"call_function","account_id":"registry.tnlab-718ca9.testnet","method_name":method,"args_base64":STANDARD.encode(serde_json::to_vec(&args).map_err(|_|"rpc_args")?),"block_id":self.block_hash}}))?;
        let result = &r["result"];
        if result["block_hash"] != self.block_hash
            || result["block_height"].as_u64().map(|n| n.to_string()) != Some(self.height.clone())
        {
            return Err("registry_block_mismatch");
        }
        let raw: Vec<u8> =
            serde_json::from_value(result["result"].clone()).map_err(|_| "registry_view")?;
        if raw.len() > 2_000_000 {
            return Err("registry_view_limit");
        }
        parse(&raw)
    }
    pub fn fund(&self, id: &str) -> Result<Value> {
        let f = self.view("get_fund", json!({"fund_id":id}))?;
        if f["fund_id"] != id || !f["account_id"].is_string() || !f["manager_id"].is_string() {
            return Err("registry_fund");
        }
        Ok(f)
    }
    pub fn snapshot(&self, scope: &Scope, fps: &[String], valuation: &str) -> Result<Snapshot> {
        if self.fund(&scope.token_id)?["account_id"] != scope.fund_account {
            return Err("source_scope_mismatch");
        }
        let mut locks = Vec::new();
        for fp in fps {
            let r = self.view("get_lock", json!({"loan_hash":fp}))?;
            let owner = if r.is_null() {
                None
            } else {
                let id = r["fund_id"].as_str().ok_or("registry_lock")?;
                Some(
                    self.fund(id)?["account_id"]
                        .as_str()
                        .ok_or("registry_fund")?
                        .to_string(),
                )
            };
            locks.push(LockRead {
                fingerprint: fp.clone(),
                completed: true,
                fund_token_id: r["fund_id"].as_str().map(str::to_string),
                owner,
            });
        }
        let mut attempts = Vec::new();
        let mut offset = 0u64;
        loop {
            let page = self.view(
                "get_attempts_page",
                json!({"fund_id":scope.token_id,"from_index":offset,"limit":100}),
            )?;
            let count = page["count"]
                .as_u64()
                .filter(|n| *n <= 10000)
                .ok_or("registry_attempts_limit")?;
            let rows = page["attempts"]
                .as_array()
                .ok_or("registry_attempts_invalid")?;
            if rows.is_empty() && offset < count {
                return Err("registry_pagination_incomplete");
            }
            for a in rows {
                let ms = a["at_ms"].as_u64().ok_or("registry_attempts_invalid")?;
                let at = truenav_engine_v2::tee::iso_from_unix((ms / 1000) as i64);
                if truenav_v3_core::timestamp(&at)? > truenav_v3_core::timestamp(valuation)? {
                    continue;
                }
                attempts.push(json!({"action_id":a["attempt_id"].as_str().ok_or("registry_attempts_invalid")?,"at":at}));
            }
            offset += rows.len() as u64;
            if offset >= count {
                break;
            }
            if offset > 10000 {
                return Err("registry_attempts_limit");
            }
        }
        let count = self
            .view("get_certificate_count", json!({"fund_id":scope.token_id}))?
            .as_u64()
            .ok_or("registry_certificate")?;
        // R8 only asks whether an earlier certificate exists. Read a bounded page of its recorded timestamps.
        let times = self.view(
            "get_certificate_history_page",
            json!({"fund_id":scope.token_id,"from_index":0,"limit":1}),
        )?;
        let times = times.as_array().ok_or("registry_certificate")?;
        if count > 0 && times.is_empty() {
            return Err("registry_pagination_incomplete");
        }
        let history:Vec<_>=times.iter().map(|t|t.as_u64().map(|ms|json!({"fund_id":scope.token_id,"signed_at":truenav_engine_v2::tee::iso_from_unix((ms/1000)as i64)})).ok_or("registry_certificate")).collect::<Result<_>>()?;
        Ok(Snapshot {
            registry_account: "registry.tnlab-718ca9.testnet".into(),
            block_height: self.height.clone(),
            block_hash: self.block_hash.clone(),
            finalized: true,
            manager_id: self.fund(&scope.token_id)?["manager_id"]
                .as_str()
                .ok_or("registry_fund")?
                .into(),
            locks,
            attempts: json!(attempts),
            certificate_history: json!(history),
            manager_funds: vec![],
            manager_attempt_log: json!({}),
        })
    }
}
