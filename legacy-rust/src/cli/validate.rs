use anyhow::Result;

use crate::registry::SourceKind;

pub async fn validate_admin_key(kind: SourceKind, key: &str) -> Result<()> {
    match kind {
        SourceKind::LogOmp | SourceKind::LogClaudeCode => Ok(()),
        SourceKind::AdminOpenAI => {
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(15))
                .build()?;
            client.get("https://api.openai.com/v1/models")
                .bearer_auth(key)
                .send().await?
                .error_for_status()
                .map(|_| ())
                .map_err(|e| anyhow::anyhow!("admin key validation failed: {e}"))
        }
        SourceKind::AdminAnthropic => {
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(15))
                .build()?;
            client.post("https://api.anthropic.com/v1/messages")
                .header("x-api-key", key)
                .header("anthropic-version", "2023-06-01")
                .json(&serde_json::json!({
                    "model": "claude-3-5-haiku-latest",
                    "max_tokens": 1,
                    "messages": [{"role": "user", "content": "ping"}],
                }))
                .send().await?
                .error_for_status()
                .map(|_| ())
                .map_err(|e| anyhow::anyhow!("admin key validation failed: {e}"))
        }
    }
}
