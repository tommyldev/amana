use anyhow::Result;

use super::super::{UsageFetcher, UsageReport};
use crate::auth::Credential;

pub struct OllamaFetcher;

#[async_trait::async_trait]
impl UsageFetcher for OllamaFetcher {
    fn provider(&self) -> &'static str {
        "ollama"
    }

    async fn fetch(&self, cred: &Credential, _client: &reqwest::Client) -> Result<Option<UsageReport>> {
        Ok(Some(UsageReport {
            provider: "ollama".into(),
            account: cred.account_label(),
            fetched_at: chrono::Utc::now().timestamp_millis(),
            limits: Vec::new(),
            notes: vec![
                "Ollama does not expose a standalone quota usage API; per-response token usage is reported during requests.".into(),
            ],
        }))
    }
}
