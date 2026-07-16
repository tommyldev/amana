use anyhow::{Context, Result};
use async_trait::async_trait;
use chrono::{Duration, Utc};
use serde::Deserialize;

use crate::config::ProviderCfg;
use crate::db::Db;
use crate::model::UsageEventRow;


use super::{FetchOutcome, Source};

pub struct AdminAnthropicSource;

#[async_trait]
impl Source for AdminAnthropicSource {
    fn id(&self) -> &str { "anthropic-api" }

    async fn fetch(&self, db: &Db, _cfg: &ProviderCfg) -> Result<FetchOutcome> {
        let key = match db.get_secret("anthropic-api")? {
            Some(k) => k,
            None => {
                db.set_provider_status("anthropic-api", "no_admin_key")?;
                return Ok(FetchOutcome { inserted: 0, status: "no_admin_key".into() });
            }
        };
        let now = Utc::now();
        let start = now - Duration::days(35);
        let url = format!(
            "https://api.anthropic.com/v1/organizations/usage?start_time={}&end_time={}&bucket_width=1d",
            start.timestamp(), now.timestamp()
        );
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()?;
        let resp = client.get(&url)
            .header("x-api-key", &key)
            .header("anthropic-version", "2023-06-01")
            .send().await
            .context("anthropic usage request")?;
        if !resp.status().is_success() {
            let status = format!("error: http {}", resp.status());
            db.set_provider_status("anthropic-api", &status)?;
            return Ok(FetchOutcome { inserted: 0, status });
        }
        let body: UsageResponse = resp.json().await.context("parse anthropic usage")?;
        let rows = parse(&body, "anthropic");
        let n = db.upsert_admin(rows)?;
        db.set_provider_status("anthropic-api", "ok")?;
        Ok(FetchOutcome { inserted: n, status: "ok".into() })
    }
}

pub fn parse(body: &UsageResponse, provider: &str) -> Vec<UsageEventRow> {
    let mut out = Vec::new();
    for bucket in &body.data {
        let ts_ms = bucket.start_time * 1000;
        for entry in &bucket.results {
            let id = format!("admin:{provider}:{}:{}", bucket.start_time, entry.model);
            out.push(UsageEventRow {
                source: "anthropic-api".into(),
                source_message_id: id,
                timestamp_ms: ts_ms,
                provider: provider.into(),
                model: entry.model.clone(),
                prompt_tokens: entry.input_tokens,
                completion_tokens: entry.output_tokens,
                cache_read_tokens: entry.cache_read_input_tokens,
                cache_write_tokens: entry.cache_creation_input_tokens,
                total_tokens: entry.input_tokens
                    + entry.output_tokens
                    + entry.cache_read_input_tokens
                    + entry.cache_creation_input_tokens,
                cost_usd: entry.amount,
                cost_origin: "api".into(),
            });
        }
    }
    out
}

#[derive(Debug, Deserialize)]
pub struct UsageResponse {
    pub data: Vec<UsageBucket>,
}

#[derive(Debug, Deserialize)]
pub struct UsageBucket {
    pub start_time: i64,
    #[serde(default)]
    pub results: Vec<UsageEntry>,
}

#[derive(Debug, Deserialize)]
pub struct UsageEntry {
    pub model: String,
    #[serde(default)]
    pub input_tokens: i64,
    #[serde(default)]
    pub output_tokens: i64,
    #[serde(default)]
    pub cache_read_input_tokens: i64,
    #[serde(default)]
    pub cache_creation_input_tokens: i64,
    #[serde(default)]
    pub amount: Option<f64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_usage_response() {
        let json = r#"{
            "data": [
                {
                    "start_time": 1717200000,
                    "end_time": 1717286400,
                    "results": [
                        {
                            "model": "claude-3-5-sonnet-20240620",
                            "input_tokens": 1000,
                            "output_tokens": 200,
                            "cache_read_input_tokens": 50,
                            "cache_creation_input_tokens": 0,
                            "amount": 0.042
                        }
                    ]
                }
            ]
        }"#;
        let body: UsageResponse = serde_json::from_str(json).unwrap();
        let rows = parse(&body, "anthropic");
        assert_eq!(rows.len(), 1);
        let r = &rows[0];
        assert_eq!(r.cost_origin, "api");
        assert_eq!(r.prompt_tokens, 1000);
        assert_eq!(r.completion_tokens, 200);
        assert!((r.cost_usd.unwrap() - 0.042).abs() < 1e-9);
    }
}
