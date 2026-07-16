use anyhow::{Context, Result};
use async_trait::async_trait;
use chrono::{Duration, Utc};
use serde::Deserialize;
use std::collections::HashMap;

use crate::config::ProviderCfg;
use crate::db::Db;
use crate::model::UsageEventRow;


use super::{FetchOutcome, Source};

pub struct AdminOpenAISource;

#[async_trait]
impl Source for AdminOpenAISource {
    fn id(&self) -> &str { "openai-api" }

    async fn fetch(&self, db: &Db, _cfg: &ProviderCfg) -> Result<FetchOutcome> {
        let key = match db.get_secret("openai-api")? {
            Some(k) => k,
            None => {
                db.set_provider_status("openai-api", "no_admin_key")?;
                return Ok(FetchOutcome { inserted: 0, status: "no_admin_key".into() });
            }
        };
        let now = Utc::now();
        let start = now - Duration::days(35);
        let url = format!(
            "https://api.openai.com/v1/organization/costs?start_time={}&end_time={}&limit=1000&group_by%5B%5D=model",
            start.timestamp(), now.timestamp()
        );
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()?;
        let resp = client.get(&url).bearer_auth(&key).send().await
            .context("openai costs request")?;
        if !resp.status().is_success() {
            let status = format!("error: http {}", resp.status());
            db.set_provider_status("openai-api", &status)?;
            return Ok(FetchOutcome { inserted: 0, status });
        }
        let body: CostsResponse = resp.json().await.context("parse openai costs")?;
        let rows = parse(&body, "openai");
        let n = db.upsert_admin(rows)?;
        db.set_provider_status("openai-api", "ok")?;
        Ok(FetchOutcome { inserted: n, status: "ok".into() })
    }
}

pub fn parse(body: &CostsResponse, provider: &str) -> Vec<UsageEventRow> {
    let mut out = Vec::new();
    for bucket in &body.data {
        // bucket.start_time is unix seconds
        let ts_ms = bucket.start_time * 1000;
        for (model, amount) in &bucket.results {
            // amount.value is USD
            let cost = *amount;
            let id = format!("admin:{provider}:{}:{}", bucket.start_time, model);
            out.push(UsageEventRow {
                source: "openai-api".into(),
                source_message_id: id,
                timestamp_ms: ts_ms,
                provider: provider.into(),
                model: model.clone(),
                prompt_tokens: 0,
                completion_tokens: 0,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
                total_tokens: 0,
                cost_usd: Some(cost),
                cost_origin: "api".into(),
            });
        }
    }
    out
}

#[derive(Debug, Deserialize)]
pub struct CostsResponse {
    pub data: Vec<CostBucket>,
    #[serde(default)]
    pub has_more: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct CostBucket {
    pub start_time: i64,
    /// results is { model_name: amount_usd }
    #[serde(default)]
    pub results: HashMap<String, f64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_costs_response() {
        let json = r#"{
            "object": "page",
            "data": [
                {
                    "object": "bucket",
                    "start_time": 1717200000,
                    "end_time": 1717286400,
                    "results": {
                        "ft:gpt-4o-2024-08-06": 0.123,
                        "gpt-4o-2024-08-06": 4.567
                    }
                }
            ],
            "has_more": false
        }"#;
        let body: CostsResponse = serde_json::from_str(json).unwrap();
        let rows = parse(&body, "openai");
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|r| r.cost_origin == "api"));
        let gpt = rows.iter().find(|r| r.model == "gpt-4o-2024-08-06").unwrap();
        assert!((gpt.cost_usd.unwrap() - 4.567).abs() < 1e-9);
    }
}
