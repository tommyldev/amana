use anyhow::Result;
use serde::Deserialize;

use super::super::{UsageAmount, UsageFetcher, UsageLimit, UsageReport, UsageScope, UsageStatus, UsageUnit, UsageWindow};
use crate::auth::Credential;

const GLOBAL_BASE: &str = "https://www.minimax.io";
const CN_BASE: &str = "https://www.minimaxi.com";
const PATH: &str = "/v1/token_plan/remains";
const FIVE_HOURS_MS: i64 = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS: i64 = 7 * 24 * 60 * 60 * 1000;

#[derive(Debug, Deserialize, Default)]
struct ResponseBody {
    #[serde(default)]
    base_resp: Option<BaseResp>,
    #[serde(default)]
    model_remains: Vec<ModelRemain>,
}

#[derive(Debug, Deserialize, Default)]
struct BaseResp {
    #[serde(default)]
    status_code: Option<i64>,
    #[serde(default)]
    status_msg: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct ModelRemain {
    #[serde(default)]
    model_name: Option<String>,
    #[serde(default)]
    current_interval_total_count: Option<f64>,
    #[serde(default)]
    current_interval_usage_count: Option<f64>,
    #[serde(default)]
    current_interval_remaining_percent: Option<f64>,
    #[serde(default)]
    end_time: Option<i64>,
    #[serde(default)]
    current_weekly_status: Option<i64>,
    #[serde(default)]
    current_weekly_total_count: Option<f64>,
    #[serde(default)]
    current_weekly_usage_count: Option<f64>,
    #[serde(default)]
    current_weekly_remaining_percent: Option<f64>,
    #[serde(default)]
    weekly_end_time: Option<i64>,
}

pub struct MiniMaxFetcher;
pub struct MiniMaxCnFetcher;

#[async_trait::async_trait]
impl UsageFetcher for MiniMaxFetcher {
    fn provider(&self) -> &'static str {
        "minimax-code"
    }

    async fn fetch(&self, cred: &Credential, client: &reqwest::Client) -> Result<Option<UsageReport>> {
        fetch_for("minimax-code", GLOBAL_BASE, cred, client).await
    }
}

#[async_trait::async_trait]
impl UsageFetcher for MiniMaxCnFetcher {
    fn provider(&self) -> &'static str {
        "minimax-code-cn"
    }

    async fn fetch(&self, cred: &Credential, client: &reqwest::Client) -> Result<Option<UsageReport>> {
        fetch_for("minimax-code-cn", CN_BASE, cred, client).await
    }
}

async fn fetch_for(
    provider: &str,
    base: &str,
    cred: &Credential,
    client: &reqwest::Client,
) -> Result<Option<UsageReport>> {
    let Credential::ApiKey(api) = cred else { return Ok(None) };
    let resp = client
        .get(format!("{base}{PATH}"))
        .header("authorization", format!("Bearer {}", api.key))
        .header("content-type", "application/json")
        .header("accept", "application/json")
        .send()
        .await?;
    if !resp.status().is_success() {
        anyhow::bail!("{provider} usage HTTP {}", resp.status());
    }
    let body: ResponseBody = resp.json().await?;
    if let Some(base_resp) = &body.base_resp {
        if base_resp.status_code.unwrap_or(0) != 0 {
            anyhow::bail!(
                "{}",
                base_resp.status_msg.clone().unwrap_or_else(|| format!("{provider} usage status {}", base_resp.status_code.unwrap_or(-1)))
            );
        }
    }
    let limits = parse_models(provider, &body.model_remains, cred.account_label());
    if limits.is_empty() {
        return Ok(None);
    }
    Ok(Some(UsageReport {
        provider: provider.into(),
        account: cred.account_label(),
        fetched_at: chrono::Utc::now().timestamp_millis(),
        limits,
        notes: Vec::new(),
    }))
}

fn parse_models(provider: &str, rows: &[ModelRemain], account: String) -> Vec<UsageLimit> {
    let representative = rows.iter().find(|r| {
        r.current_interval_remaining_percent.is_some()
            || r.current_weekly_remaining_percent.is_some()
            || r.current_interval_total_count.is_some()
    });
    let Some(row) = representative else { return Vec::new() };
    let mut limits = Vec::new();

    if let Some(limit) = build_window_limit(
        provider,
        &account,
        row.model_name.clone(),
        "5h",
        "MiniMax 5 Hour",
        FIVE_HOURS_MS,
        row.current_interval_total_count,
        row.current_interval_usage_count,
        row.current_interval_remaining_percent,
        row.end_time,
    ) {
        limits.push(limit);
    }

    if row.current_weekly_status.unwrap_or(1) != 0 {
        if let Some(limit) = build_window_limit(
            provider,
            &account,
            row.model_name.clone(),
            "7d",
            "MiniMax 7 Day",
            SEVEN_DAYS_MS,
            row.current_weekly_total_count,
            row.current_weekly_usage_count,
            row.current_weekly_remaining_percent,
            row.weekly_end_time,
        ) {
            limits.push(limit);
        }
    }
    limits
}

fn build_window_limit(
    provider: &str,
    account: &str,
    model_name: Option<String>,
    window_id: &str,
    label: &str,
    duration_ms: i64,
    total: Option<f64>,
    usage_count: Option<f64>,
    remaining_percent: Option<f64>,
    reset_time: Option<i64>,
) -> Option<UsageLimit> {
    let remaining_fraction = remaining_percent.map(|v| (v / 100.0).clamp(0.0, 1.0));
    let used_fraction = remaining_fraction.map(|v| 1.0 - v).or_else(|| {
        match (total, usage_count) {
            (Some(t), Some(rem)) if t > 0.0 => Some(((t - rem).max(0.0) / t).clamp(0.0, 1.0)),
            _ => None,
        }
    });
    if used_fraction.is_none() && remaining_fraction.is_none() {
        return None;
    }
    let used = match (total, usage_count, used_fraction) {
        (Some(t), Some(rem), _) => Some((t - rem).max(0.0)),
        (_, _, Some(frac)) => Some(frac * 100.0),
        _ => None,
    };
    let limit = total.or_else(|| used_fraction.map(|_| 100.0));
    let remaining = match (total, usage_count, remaining_fraction) {
        (Some(_), Some(rem), _) => Some(rem.max(0.0)),
        (_, _, Some(frac)) => Some(frac * 100.0),
        _ => None,
    };
    Some(UsageLimit {
        id: format!("{provider}:{window_id}"),
        label: label.into(),
        tier: None,
        scope: UsageScope {
            provider: provider.into(),
            account_id: Some(account.into()),
            project_id: None,
            org_id: None,
            model_id: model_name,
            tier: None,
            window_id: Some(window_id.into()),
            shared: true,
        },
        window: Some(UsageWindow {
            id: window_id.into(),
            label: if window_id == "5h" { "5 Hour".into() } else { "7 Day".into() },
            duration_ms: Some(duration_ms),
            resets_at: normalize_epoch_ms(reset_time),
        }),
        amount: UsageAmount {
            used,
            limit,
            remaining,
            used_fraction,
            remaining_fraction,
            unit: if total.is_some() { UsageUnit::Requests } else { UsageUnit::Percent },
        },
        status: status_of(used_fraction),
        notes: Vec::new(),
    })
}

fn normalize_epoch_ms(ts: Option<i64>) -> Option<i64> {
    let ts = ts?;
    Some(if ts.abs() > 10_000_000_000 { ts } else { ts * 1000 })
}

fn status_of(used_fraction: Option<f64>) -> UsageStatus {
    match used_fraction {
        Some(f) if f >= 1.0 => UsageStatus::Exhausted,
        Some(f) if f >= 0.9 => UsageStatus::Warning,
        Some(_) => UsageStatus::Ok,
        None => UsageStatus::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_token_plan_windows() {
        let rows = vec![ModelRemain {
            model_name: Some("general".into()),
            current_interval_total_count: Some(100.0),
            current_interval_usage_count: Some(6.0),
            current_interval_remaining_percent: Some(94.0),
            end_time: Some(1781834400000),
            current_weekly_status: Some(1),
            current_weekly_total_count: Some(1000.0),
            current_weekly_usage_count: Some(650.0),
            current_weekly_remaining_percent: Some(65.0),
            weekly_end_time: Some(1782057600000),
        }];
        let limits = parse_models("minimax-code", &rows, "acct".into());
        assert_eq!(limits.len(), 2);
        let five = limits.iter().find(|l| l.id == "minimax-code:5h").unwrap();
        assert!((five.amount.used_fraction.unwrap() - 0.06).abs() < 1e-9);
        let weekly = limits.iter().find(|l| l.id == "minimax-code:7d").unwrap();
        assert!((weekly.amount.used_fraction.unwrap() - 0.35).abs() < 1e-9);
    }

    #[test]
    fn suppresses_missing_weekly_window() {
        let rows = vec![ModelRemain {
            model_name: Some("general".into()),
            current_interval_total_count: Some(100.0),
            current_interval_usage_count: Some(0.0),
            current_interval_remaining_percent: Some(100.0),
            end_time: Some(1781834400000),
            current_weekly_status: Some(0),
            ..Default::default()
        }];
        let limits = parse_models("minimax-code", &rows, "acct".into());
        assert_eq!(limits.len(), 1);
    }
}
