use anyhow::Result;
use serde::Deserialize;

use super::super::{UsageAmount, UsageFetcher, UsageLimit, UsageReport, UsageScope, UsageStatus, UsageUnit, UsageWindow};
use crate::auth::Credential;

const DEFAULT_BASE: &str = "https://chatgpt.com/backend-api/codex";

#[derive(Debug, Deserialize, Default)]
struct UsagePayload {
    #[serde(default)]
    plan_type: Option<String>,
    #[serde(default)]
    rate_limit: Option<RateLimitPayload>,
}

#[derive(Debug, Deserialize, Default)]
struct RateLimitPayload {
    #[serde(default)]
    limit_reached: Option<bool>,
    #[serde(default)]
    primary_window: Option<WindowPayload>,
    #[serde(default)]
    secondary_window: Option<WindowPayload>,
}

#[derive(Debug, Deserialize, Default)]
struct WindowPayload {
    #[serde(default)]
    used_percent: Option<f64>,
    #[serde(default)]
    limit_window_seconds: Option<i64>,
    #[serde(default)]
    reset_after_seconds: Option<i64>,
    #[serde(default)]
    reset_at: Option<i64>,
}

pub struct OpenAICodexFetcher;

#[async_trait::async_trait]
impl UsageFetcher for OpenAICodexFetcher {
    fn provider(&self) -> &'static str {
        "openai-codex"
    }

    async fn fetch(&self, cred: &Credential, client: &reqwest::Client) -> Result<Option<UsageReport>> {
        let (access, account_id, email, base) = match cred {
            Credential::Oauth(oauth) => (
                oauth.access.clone(),
                oauth.account_id.clone(),
                oauth.email.clone(),
                oauth.enterprise_url.clone().unwrap_or_else(|| DEFAULT_BASE.into()),
            ),
            Credential::ApiKey(api) => (
                api.key.clone(),
                api.account.clone(),
                None,
                api.enterprise_url.clone().unwrap_or_else(|| DEFAULT_BASE.into()),
            ),
        };
        let url = format!("{}/wham/usage", base.trim_end_matches('/'));
        let mut req = client
            .get(url)
            .header("authorization", format!("Bearer {access}"))
            .header("user-agent", "OpenCode-Status-Plugin/1.0");
        if let Some(account_id) = &account_id {
            req = req.header("ChatGPT-Account-Id", account_id);
        }
        let resp = req.send().await?;
        if !resp.status().is_success() {
            anyhow::bail!("openai-codex usage HTTP {}", resp.status());
        }
        let body: UsagePayload = resp.json().await?;
        let Some(rate) = body.rate_limit else { return Ok(None) };
        let mut limits = Vec::new();
        if let Some(primary) = rate.primary_window {
            limits.push(build_limit("primary", &primary, rate.limit_reached.unwrap_or(false), body.plan_type.clone(), account_id.clone()));
        }
        if let Some(secondary) = rate.secondary_window {
            limits.push(build_limit("secondary", &secondary, rate.limit_reached.unwrap_or(false), body.plan_type.clone(), account_id.clone()));
        }
        if limits.is_empty() {
            return Ok(None);
        }
        Ok(Some(UsageReport {
            provider: "openai-codex".into(),
            account: email.or(account_id).unwrap_or_else(|| cred.account_label()),
            fetched_at: chrono::Utc::now().timestamp_millis(),
            limits,
            notes: Vec::new(),
        }))
    }
}

fn build_limit(key: &str, window: &WindowPayload, limit_reached: bool, plan_type: Option<String>, account_id: Option<String>) -> UsageLimit {
    let used_fraction = window.used_percent.map(|p| (p / 100.0).clamp(0.0, 1.0));
    let duration_ms = window.limit_window_seconds.map(|s| s * 1000);
    let resets_at = window.reset_at.map(normalize_epoch_ms).or_else(|| window.reset_after_seconds.map(|s| chrono::Utc::now().timestamp_millis() + s * 1000));
    let usage_window = UsageWindow {
        id: key.into(),
        label: if key == "primary" { "Primary window".into() } else { "Secondary window".into() },
        duration_ms,
        resets_at,
    };
    UsageLimit {
        id: format!("openai-codex:{key}"),
        label: usage_window.label.clone(),
        tier: plan_type.clone(),
        scope: UsageScope {
            provider: "openai-codex".into(),
            account_id,
            project_id: None,
            org_id: None,
            model_id: None,
            tier: plan_type,
            window_id: Some(key.into()),
            shared: true,
        },
        window: Some(usage_window),
        amount: UsageAmount {
            used: used_fraction.map(|v| v * 100.0),
            limit: Some(100.0),
            remaining: used_fraction.map(|v| (1.0 - v).max(0.0) * 100.0),
            used_fraction,
            remaining_fraction: used_fraction.map(|v| (1.0 - v).max(0.0)),
            unit: UsageUnit::Percent,
        },
        status: if limit_reached {
            UsageStatus::Exhausted
        } else {
            match used_fraction {
                Some(f) if f >= 1.0 => UsageStatus::Exhausted,
                Some(f) if f >= 0.9 => UsageStatus::Warning,
                Some(_) => UsageStatus::Ok,
                None => UsageStatus::Unknown,
            }
        },
        notes: Vec::new(),
    }
}

fn normalize_epoch_ms(ts: i64) -> i64 {
    if ts.abs() > 1_000_000_000_000 { ts } else { ts * 1000 }
}
