//! Z.AI (GLM Coding Plan) usage fetcher — API key.
//! Ports oh-my-pi's `zaiUsageProvider`: GET /api/monitor/usage/quota/limit.
use anyhow::Result;
use serde::Deserialize;

use super::super::http;
use super::super::{UsageAmount, UsageFetcher, UsageLimit, UsageReport, UsageScope, UsageStatus, UsageUnit, UsageWindow};
use crate::auth::Credential;

const ENDPOINT: &str = "https://api.z.ai";
const QUOTA_PATH: &str = "/api/monitor/usage/quota/limit";
const SEVEN_DAYS_MS: i64 = 7 * 24 * 60 * 60 * 1000;

#[derive(Deserialize)]
struct QuotaPayload {
    success: Option<bool>,
    data: Option<QuotaData>,
}
#[derive(Deserialize)]
struct QuotaData {
    limits: Option<Vec<LimitItem>>,
}
#[derive(Deserialize)]
struct LimitItem {
    #[serde(rename = "type")]
    kind: Option<String>,
    usage: Option<f64>,
    #[serde(rename = "currentValue")]
    current_value: Option<f64>,
    percentage: Option<f64>,
    remaining: Option<f64>,
    #[serde(rename = "nextResetTime")]
    next_reset_time: Option<f64>,
}

fn parse_millis(v: Option<f64>) -> Option<i64> {
    let v = v?;
    Some(if v > 1_000_000_000_000.0 { v as i64 } else { (v * 1000.0) as i64 })
}

fn build_amount(
    used: Option<f64>,
    limit: Option<f64>,
    remaining: Option<f64>,
    percentage: Option<f64>,
    unit: UsageUnit,
) -> UsageAmount {
    let used_fraction = if let Some(p) = percentage {
        Some((p / 100.0).clamp(0.0, 1.0))
    } else if let (Some(u), Some(l)) = (used, limit) {
        if l > 0.0 { Some((u / l).min(1.0)) } else { None }
    } else {
        None
    };
    let remaining_fraction = used_fraction.map(|f| (1.0 - f).max(0.0));
    UsageAmount { used, limit, remaining, used_fraction, remaining_fraction, unit }
}

pub(crate) fn status_of(used_fraction: Option<f64>) -> UsageStatus {
    match used_fraction {
        Some(f) if f >= 1.0 => UsageStatus::Exhausted,
        Some(f) if f >= 0.9 => UsageStatus::Warning,
        Some(_) => UsageStatus::Ok,
        None => UsageStatus::Unknown,
    }
}

fn parse(payload: QuotaPayload) -> Vec<UsageLimit> {
    if payload.success != Some(true) {
        return Vec::new();
    }
    let items = payload.data.and_then(|d| d.limits).unwrap_or_default();
    let mut limits = Vec::new();
    for it in items {
        let Some(kind) = it.kind.as_deref() else { continue };
        let window = UsageWindow {
            id: "quota".into(),
            label: "Quota".into(),
            duration_ms: Some(SEVEN_DAYS_MS),
            resets_at: parse_millis(it.next_reset_time),
        };
        let (id, label, unit) = match kind {
            "TOKENS_LIMIT" => ("zai:tokens", "ZAI Token Quota", UsageUnit::Tokens),
            "TIME_LIMIT" => ("zai:requests", "ZAI Request Quota", UsageUnit::Requests),
            _ => continue,
        };
        // omp maps used=currentValue, limit=usage.
        let amount = build_amount(it.current_value, it.usage, it.remaining, it.percentage, unit);
        let status = status_of(amount.used_fraction);
        limits.push(UsageLimit {
            id: id.into(),
            label: label.into(),
            tier: None,
            scope: UsageScope {
                provider: "zai".into(),
                account_id: None,
                project_id: None,
                org_id: None,
                model_id: None,
                tier: None,
                window_id: Some("quota".into()),
                shared: true,
            },
            window: Some(window),
            amount,
            status,
            notes: Vec::new(),
        });
    }
    limits
}

pub struct ZaiFetcher;

#[async_trait::async_trait]
impl UsageFetcher for ZaiFetcher {
    fn provider(&self) -> &'static str {
        "zai"
    }

    async fn fetch(&self, cred: &Credential, client: &reqwest::Client) -> Result<Option<UsageReport>> {
        let Credential::ApiKey(api) = cred else { return Ok(None) };
        let url = format!("{ENDPOINT}{QUOTA_PATH}");
        let key = api.key.clone();
        let resp = http::send_retry(
            || {
                client
                    .get(&url)
                    .header("Authorization", &key)
                    .header("Content-Type", "application/json")
                    .header("User-Agent", "OpenCode-Status-Plugin/1.0")
            },
            3,
        )
        .await?;
        if !resp.status().is_success() {
            anyhow::bail!("zai usage HTTP {}", resp.status());
        }
        let payload: QuotaPayload = resp.json().await?;
        let limits = parse(payload);
        if limits.is_empty() {
            return Ok(None);
        }
        Ok(Some(UsageReport {
            provider: "zai".into(),
            account: cred.account_label(),
            fetched_at: chrono::Utc::now().timestamp_millis(),
            limits,
            notes: Vec::new(),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_real_wire_shape() {
        // Mirrors z.ai's /quota/limit response: a token quota + a request quota.
        let json = serde_json::json!({
            "success": true,
            "data": { "limits": [
                { "type": "TOKENS_LIMIT", "currentValue": 84.0, "usage": 100.0, "percentage": 84.0, "nextResetTime": 1782944326998i64 },
                { "type": "TIME_LIMIT", "currentValue": 0.0, "usage": 1000.0, "percentage": 0.0, "remaining": 1000.0, "nextResetTime": 1784931526972i64 }
            ]}
        });
        let payload: QuotaPayload = serde_json::from_value(json).unwrap();
        let limits = parse(payload);
        assert_eq!(limits.len(), 2);
        let tok = limits.iter().find(|l| l.id == "zai:tokens").unwrap();
        assert_eq!(tok.amount.unit, UsageUnit::Tokens);
        assert!((tok.amount.used_fraction.unwrap() - 0.84).abs() < 1e-9);
        assert_eq!(tok.window.as_ref().unwrap().resets_at, Some(1782944326998));
        let req = limits.iter().find(|l| l.id == "zai:requests").unwrap();
        assert_eq!(req.amount.unit, UsageUnit::Requests);
        assert_eq!(req.status, UsageStatus::Ok);
    }

    #[test]
    fn unsuccessful_payload_yields_no_limits() {
        let payload: QuotaPayload =
            serde_json::from_value(serde_json::json!({ "success": false })).unwrap();
        assert!(parse(payload).is_empty());
    }
}
