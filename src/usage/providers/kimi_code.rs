use anyhow::Result;
use serde::Deserialize;

use super::super::{UsageAmount, UsageFetcher, UsageLimit, UsageReport, UsageScope, UsageStatus, UsageUnit, UsageWindow};
use crate::auth::Credential;

const DEFAULT_BASE_URL: &str = "https://api.kimi.com/coding/v1";

#[derive(Debug, Deserialize, Default)]
struct KimiUsagePayload {
    #[serde(default)]
    usage: Option<KimiUsage>,
    #[serde(default)]
    limits: Vec<KimiLimit>,
}

#[derive(Debug, Deserialize, Default)]
struct KimiUsage {
    #[serde(default)]
    limit: Option<f64>,
    #[serde(default)]
    remaining: Option<f64>,
    #[serde(default, rename = "resetTime")]
    reset_time: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct KimiLimit {
    #[serde(default)]
    detail: Option<KimiUsage>,
    #[serde(default)]
    window: Option<KimiWindow>,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct KimiWindow {
    #[serde(default)]
    duration: Option<i64>,
    #[serde(default, rename = "timeUnit")]
    time_unit: Option<String>,
}

pub struct KimiCodeFetcher;

#[async_trait::async_trait]
impl UsageFetcher for KimiCodeFetcher {
    fn provider(&self) -> &'static str {
        "kimi-code"
    }

    async fn fetch(&self, cred: &Credential, client: &reqwest::Client) -> Result<Option<UsageReport>> {
        let Credential::Oauth(oauth) = cred else { return Ok(None) };
        let base = oauth.enterprise_url.clone().unwrap_or_else(|| DEFAULT_BASE_URL.into());
        let base = base.trim_end_matches('/').to_string();
        let resp = client
            .get(format!("{base}/usages"))
            .header("authorization", format!("Bearer {}", oauth.access))
            .header("accept", "application/json")
            .send()
            .await?;
        if !resp.status().is_success() {
            anyhow::bail!("kimi-code usage HTTP {}", resp.status());
        }
        let body: KimiUsagePayload = resp.json().await?;
        let mut limits = Vec::new();
        if let Some(summary) = &body.usage {
            if let Some(limit) = build_summary_limit(summary, oauth.account_id.clone()) {
                limits.push(limit);
            }
        }
        for (idx, limit) in body.limits.iter().enumerate() {
            if let Some(detail) = &limit.detail {
                if let Some(row) = build_detail_limit(idx, limit.name.clone(), detail, limit.window.as_ref(), oauth.account_id.clone()) {
                    limits.push(row);
                }
            }
        }
        if limits.is_empty() {
            return Ok(None);
        }
        Ok(Some(UsageReport {
            provider: "kimi-code".into(),
            account: oauth.email.clone().or(oauth.account_id.clone()).unwrap_or_else(|| "account".into()),
            fetched_at: chrono::Utc::now().timestamp_millis(),
            limits,
            notes: Vec::new(),
        }))
    }
}

fn build_summary_limit(detail: &KimiUsage, account_id: Option<String>) -> Option<UsageLimit> {
    build_limit("kimi-code:summary", "Total quota", detail, None, account_id)
}

fn build_detail_limit(
    idx: usize,
    name: Option<String>,
    detail: &KimiUsage,
    window: Option<&KimiWindow>,
    account_id: Option<String>,
) -> Option<UsageLimit> {
    build_limit(
        &format!("kimi-code:{idx}"),
        &name.unwrap_or_else(|| "Usage window".into()),
        detail,
        window,
        account_id,
    )
}

fn build_limit(
    id: &str,
    label: &str,
    detail: &KimiUsage,
    window: Option<&KimiWindow>,
    account_id: Option<String>,
) -> Option<UsageLimit> {
    let limit = detail.limit;
    let remaining = detail.remaining;
    let used = match (limit, remaining) {
        (Some(l), Some(r)) => Some((l - r).max(0.0)),
        _ => None,
    };
    let used_fraction = match (used, limit) {
        (Some(u), Some(l)) if l > 0.0 => Some((u / l).clamp(0.0, 1.0)),
        _ => None,
    };
    if limit.is_none() && used_fraction.is_none() {
        return None;
    }
    let usage_window = window.map(|w| UsageWindow {
        id: "window".into(),
        label: window_label(w).unwrap_or_else(|| "Usage window".into()),
        duration_ms: window_duration_ms(w),
        resets_at: detail.reset_time.as_deref().and_then(parse_time),
    }).or_else(|| detail.reset_time.as_deref().and_then(|ts| Some(UsageWindow {
        id: "window".into(),
        label: "Usage window".into(),
        duration_ms: None,
        resets_at: parse_time(ts),
    })));
    Some(UsageLimit {
        id: id.into(),
        label: label.into(),
        tier: None,
        scope: UsageScope {
            provider: "kimi-code".into(),
            account_id,
            project_id: None,
            org_id: None,
            model_id: None,
            tier: None,
            window_id: usage_window.as_ref().map(|w| w.id.clone()),
            shared: true,
        },
        window: usage_window,
        amount: UsageAmount {
            used,
            limit,
            remaining,
            used_fraction,
            remaining_fraction: used_fraction.map(|v| (1.0 - v).max(0.0)),
            unit: UsageUnit::Unknown,
        },
        status: match used_fraction {
            Some(f) if f >= 1.0 => UsageStatus::Exhausted,
            Some(f) if f >= 0.9 => UsageStatus::Warning,
            Some(_) => UsageStatus::Ok,
            None => UsageStatus::Unknown,
        },
        notes: Vec::new(),
    })
}

fn parse_time(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value).ok().map(|d| d.timestamp_millis())
}

fn window_label(window: &KimiWindow) -> Option<String> {
    let duration = window.duration?;
    let unit = window.time_unit.as_deref()?.to_ascii_uppercase();
    if unit.contains("MINUTE") {
        if duration >= 60 && duration % 60 == 0 {
            Some(format!("{} Hour", duration / 60))
        } else {
            Some(format!("{} Minute", duration))
        }
    } else if unit.contains("HOUR") {
        Some(format!("{} Hour", duration))
    } else if unit.contains("DAY") {
        Some(format!("{} Day", duration))
    } else {
        None
    }
}

fn window_duration_ms(window: &KimiWindow) -> Option<i64> {
    let duration = window.duration?;
    let unit = window.time_unit.as_deref()?.to_ascii_uppercase();
    if unit.contains("MINUTE") {
        Some(duration * 60_000)
    } else if unit.contains("HOUR") {
        Some(duration * 3_600_000)
    } else if unit.contains("DAY") {
        Some(duration * 86_400_000)
    } else {
        None
    }
}
