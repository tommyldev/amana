use anyhow::Result;
use serde::Deserialize;

use super::super::{UsageAmount, UsageFetcher, UsageLimit, UsageReport, UsageScope, UsageStatus, UsageUnit, UsageWindow};
use crate::auth::Credential;

const DEFAULT_ENDPOINT: &str = "https://cloudcode-pa.googleapis.com";

#[derive(Debug, Deserialize, Default)]
struct LoadCodeAssistResponse {
    #[serde(default)]
    cloudaicompanion_project: Option<serde_json::Value>,
    #[serde(default)]
    current_tier: Option<TierInfo>,
}

#[derive(Debug, Deserialize, Default)]
struct TierInfo {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct RetrieveUserQuotaResponse {
    #[serde(default)]
    buckets: Vec<QuotaBucket>,
}

#[derive(Debug, Deserialize, Default)]
struct QuotaBucket {
    #[serde(default)]
    model_id: Option<String>,
    #[serde(default)]
    remaining_fraction: Option<f64>,
    #[serde(default)]
    reset_time: Option<String>,
}

pub struct GoogleGeminiCliFetcher;

#[async_trait::async_trait]
impl UsageFetcher for GoogleGeminiCliFetcher {
    fn provider(&self) -> &'static str {
        "google-gemini-cli"
    }

    async fn fetch(&self, cred: &Credential, client: &reqwest::Client) -> Result<Option<UsageReport>> {
        let Credential::Oauth(oauth) = cred else { return Ok(None) };
        let access = &oauth.access;
        let base = oauth.enterprise_url.clone().unwrap_or_else(|| DEFAULT_ENDPOINT.into());
        let base = base.trim_end_matches('/').to_string();

        let load: LoadCodeAssistResponse = client
            .post(format!("{base}/v1internal:loadCodeAssist"))
            .header("authorization", format!("Bearer {access}"))
            .header("content-type", "application/json")
            .header("user-agent", "GeminiCLI/0.46.0")
            .header("client-metadata", "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI")
            .json(&serde_json::json!({
                "cloudaicompanionProject": oauth.project_id,
                "metadata": {
                    "ideType": "IDE_UNSPECIFIED",
                    "platform": "PLATFORM_UNSPECIFIED",
                    "pluginType": "GEMINI"
                }
            }))
            .send()
            .await?
            .json()
            .await?;

        let project_id = oauth
            .project_id
            .clone()
            .or_else(|| extract_project_id(load.cloudaicompanion_project.as_ref()))
            .ok_or_else(|| anyhow::anyhow!("google-gemini-cli credential missing project_id"))?;

        let quota: RetrieveUserQuotaResponse = client
            .post(format!("{base}/v1internal:retrieveUserQuota"))
            .header("authorization", format!("Bearer {access}"))
            .header("content-type", "application/json")
            .header("user-agent", "GeminiCLI/0.46.0")
            .header("client-metadata", "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI")
            .json(&serde_json::json!({ "project": project_id }))
            .send()
            .await?
            .json()
            .await?;

        let limits = quota
            .buckets
            .iter()
            .enumerate()
            .map(|(idx, bucket)| build_limit(bucket, idx, oauth.account_id.clone(), project_id.clone()))
            .collect::<Vec<_>>();
        if limits.is_empty() {
            return Ok(None);
        }
        Ok(Some(UsageReport {
            provider: "google-gemini-cli".into(),
            account: oauth.email.clone().or(oauth.account_id.clone()).or(Some(project_id)).unwrap_or_else(|| "account".into()),
            fetched_at: chrono::Utc::now().timestamp_millis(),
            limits,
            notes: vec![load.current_tier.and_then(|t| t.name).unwrap_or_default()].into_iter().filter(|s| !s.is_empty()).collect(),
        }))
    }
}

fn extract_project_id(value: Option<&serde_json::Value>) -> Option<String> {
    match value {
        Some(serde_json::Value::String(s)) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Some(serde_json::Value::Object(map)) => map.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()),
        _ => None,
    }
}

fn build_limit(bucket: &QuotaBucket, idx: usize, account_id: Option<String>, project_id: String) -> UsageLimit {
    let remaining_fraction = bucket.remaining_fraction.map(|v| v.clamp(0.0, 1.0));
    let used_fraction = remaining_fraction.map(|v| 1.0 - v);
    UsageLimit {
        id: format!("google-gemini-cli:{}:{}", bucket.model_id.clone().unwrap_or_else(|| "unknown".into()), idx),
        label: bucket
            .model_id
            .clone()
            .map(|m| format!("Gemini {m}"))
            .unwrap_or_else(|| "Gemini quota".into()),
        tier: bucket.model_id.as_ref().and_then(|m| tier_for(m)),
        scope: UsageScope {
            provider: "google-gemini-cli".into(),
            account_id,
            project_id: Some(project_id),
            org_id: None,
            model_id: bucket.model_id.clone(),
            tier: bucket.model_id.as_ref().and_then(|m| tier_for(m)),
            window_id: Some("quota".into()),
            shared: false,
        },
        window: Some(UsageWindow {
            id: "quota".into(),
            label: "Quota window".into(),
            duration_ms: None,
            resets_at: bucket.reset_time.as_deref().and_then(parse_time),
        }),
        amount: UsageAmount {
            used: used_fraction.map(|v| v * 100.0),
            limit: Some(100.0),
            remaining: remaining_fraction.map(|v| v * 100.0),
            used_fraction,
            remaining_fraction,
            unit: UsageUnit::Percent,
        },
        status: match remaining_fraction {
            Some(f) if f <= 0.0 => UsageStatus::Exhausted,
            Some(f) if f <= 0.1 => UsageStatus::Warning,
            Some(_) => UsageStatus::Ok,
            None => UsageStatus::Unknown,
        },
        notes: Vec::new(),
    }
}

fn parse_time(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value).ok().map(|d| d.timestamp_millis())
}

fn tier_for(model: &str) -> Option<String> {
    let lower = model.to_lowercase();
    if lower.contains("3-flash") {
        Some("3-Flash".into())
    } else if lower.contains("flash") {
        Some("Flash".into())
    } else if lower.contains("pro") {
        Some("Pro".into())
    } else {
        None
    }
}
