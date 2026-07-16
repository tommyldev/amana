use anyhow::Result;
use serde::Deserialize;

use super::super::{UsageAmount, UsageFetcher, UsageLimit, UsageReport, UsageScope, UsageStatus, UsageUnit, UsageWindow};
use crate::auth::Credential;

const DEFAULT_API: &str = "https://api.github.com";

#[derive(Debug, Deserialize)]
struct CopilotUsageResponse {
    #[serde(default)]
    copilot_plan: Option<String>,
    #[serde(default)]
    quota_reset_date: Option<String>,
    #[serde(default)]
    quota_reset_date_utc: Option<String>,
    #[serde(default)]
    quota_snapshots: Option<CopilotQuotaSnapshots>,
}

#[derive(Debug, Deserialize, Default)]
struct CopilotQuotaSnapshots {
    #[serde(default)]
    premium_interactions: Option<CopilotQuotaDetail>,
    #[serde(default)]
    chat: Option<CopilotQuotaDetail>,
    #[serde(default)]
    completions: Option<CopilotQuotaDetail>,
}

#[derive(Debug, Deserialize)]
struct CopilotQuotaDetail {
    entitlement: f64,
    remaining: f64,
    #[serde(default)]
    unlimited: bool,
    #[serde(default)]
    overage_count: Option<f64>,
}

pub struct GitHubCopilotFetcher;

#[async_trait::async_trait]
impl UsageFetcher for GitHubCopilotFetcher {
    fn provider(&self) -> &'static str {
        "github-copilot"
    }

    async fn fetch(&self, cred: &Credential, client: &reqwest::Client) -> Result<Option<UsageReport>> {
        let (token, account, enterprise_url) = match cred {
            Credential::ApiKey(api) => (&api.key, cred.account_label(), api.enterprise_url.clone()),
            Credential::Oauth(oauth) => (&oauth.access, cred.account_label(), oauth.enterprise_url.clone()),
        };
        let base = enterprise_url.unwrap_or_else(|| DEFAULT_API.into()).trim_end_matches('/').to_string();
        let resp = client
            .get(format!("{base}/copilot_internal/user"))
            .header("authorization", format!("Bearer {token}"))
            .header("accept", "application/json")
            .header("x-github-api-version", "2025-04-01")
            .send()
            .await?;
        if !resp.status().is_success() {
            anyhow::bail!("github-copilot usage HTTP {}", resp.status());
        }
        let body: CopilotUsageResponse = resp.json().await?;
        let window = parse_window(body.quota_reset_date.as_deref().or(body.quota_reset_date_utc.as_deref()));
        let plan = body.copilot_plan.clone();
        let mut limits = Vec::new();
        if let Some(snapshots) = body.quota_snapshots {
            if let Some(q) = snapshots.premium_interactions {
                limits.push(build_limit("premium", "Premium Requests", &account, plan.clone(), &window, q));
            }
            if let Some(q) = snapshots.chat {
                if !q.unlimited {
                    limits.push(build_limit("chat", "Chat Requests", &account, plan.clone(), &window, q));
                }
            }
            if let Some(q) = snapshots.completions {
                if !q.unlimited {
                    limits.push(build_limit("completions", "Completions", &account, plan.clone(), &window, q));
                }
            }
        }
        if limits.is_empty() {
            return Ok(None);
        }
        Ok(Some(UsageReport {
            provider: "github-copilot".into(),
            account,
            fetched_at: chrono::Utc::now().timestamp_millis(),
            limits,
            notes: Vec::new(),
        }))
    }
}

fn parse_window(reset: Option<&str>) -> Option<UsageWindow> {
    let ts = reset.and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp_millis()))?;
    Some(UsageWindow { id: "monthly".into(), label: "Monthly".into(), duration_ms: None, resets_at: Some(ts) })
}

fn build_limit(
    key: &str,
    label: &str,
    account: &str,
    plan: Option<String>,
    window: &Option<UsageWindow>,
    quota: CopilotQuotaDetail,
) -> UsageLimit {
    let used = if quota.unlimited { None } else { Some((quota.entitlement - quota.remaining).max(0.0)) };
    let limit = if quota.unlimited { None } else { Some(quota.entitlement) };
    let used_fraction = match (used, limit) {
        (Some(u), Some(l)) if l > 0.0 => Some((u / l).clamp(0.0, 1.0)),
        _ => None,
    };
    let remaining = match (used, limit) {
        (Some(u), Some(l)) => Some((l - u).max(0.0)),
        _ => None,
    };
    let notes = quota
        .overage_count
        .filter(|v| *v > 0.0)
        .map(|v| vec![format!("Overage requests: {v:.0}")])
        .unwrap_or_default();
    UsageLimit {
        id: format!("github-copilot:{key}"),
        label: label.into(),
        tier: plan.clone(),
        scope: UsageScope {
            provider: "github-copilot".into(),
            account_id: Some(account.into()),
            project_id: None,
            org_id: None,
            model_id: None,
            tier: plan,
            window_id: Some("monthly".into()),
            shared: true,
        },
        window: window.clone(),
        amount: UsageAmount {
            used,
            limit,
            remaining,
            used_fraction,
            remaining_fraction: used_fraction.map(|v| (1.0 - v).max(0.0)),
            unit: UsageUnit::Requests,
        },
        status: status_of(used_fraction, quota.unlimited),
        notes,
    }
}

fn status_of(used_fraction: Option<f64>, unlimited: bool) -> UsageStatus {
    if unlimited {
        return UsageStatus::Ok;
    }
    match used_fraction {
        Some(f) if f >= 1.0 => UsageStatus::Exhausted,
        Some(f) if f >= 0.9 => UsageStatus::Warning,
        Some(_) => UsageStatus::Ok,
        None => UsageStatus::Unknown,
    }
}
