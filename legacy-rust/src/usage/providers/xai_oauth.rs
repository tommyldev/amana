use anyhow::Result;
use serde::Deserialize;

use super::super::{UsageAmount, UsageFetcher, UsageLimit, UsageReport, UsageScope, UsageStatus, UsageUnit, UsageWindow};
use crate::auth::Credential;

const BILLING_URL: &str = "https://cli-chat-proxy.grok.com/v1/billing";

#[derive(Debug, Deserialize, Default)]
struct BillingResponse {
    #[serde(default, rename = "billingCycle")]
    billing_cycle: Option<BillingCycle>,
    #[serde(default, rename = "monthlyLimit")]
    monthly_limit: Option<MoneyVal>,
    #[serde(default)]
    usage: Option<UsageSummary>,
}

#[derive(Debug, Deserialize, Default)]
struct BillingCycle {
    #[serde(default, rename = "billingPeriodEnd")]
    billing_period_end: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct MoneyVal {
    #[serde(default)]
    val: Option<i64>,
}

#[derive(Debug, Deserialize, Default)]
struct UsageSummary {
    #[serde(default, rename = "totalUsed")]
    total_used: Option<MoneyVal>,
}

pub struct XaiOauthFetcher;

#[async_trait::async_trait]
impl UsageFetcher for XaiOauthFetcher {
    fn provider(&self) -> &'static str {
        "xai-oauth"
    }

    async fn fetch(&self, cred: &Credential, client: &reqwest::Client) -> Result<Option<UsageReport>> {
        let Credential::Oauth(oauth) = cred else { return Ok(None) };
        let resp = client
            .get(BILLING_URL)
            .header("authorization", format!("Bearer {}", oauth.access))
            .header("x-xai-token-auth", "xai-grok-cli")
            .header("accept", "application/json")
            .send()
            .await?;
        if !resp.status().is_success() {
            anyhow::bail!("xai-oauth usage HTTP {}", resp.status());
        }
        let body: BillingResponse = resp.json().await?;
        let used_cents = body.usage.and_then(|u| u.total_used).and_then(|m| m.val).map(|v| v as f64 / 100.0);
        let limit_cents = body.monthly_limit.and_then(|m| m.val).map(|v| v as f64 / 100.0);
        let used_fraction = match (used_cents, limit_cents) {
            (Some(u), Some(l)) if l > 0.0 => Some((u / l).clamp(0.0, 1.0)),
            _ => None,
        };
        let resets_at = body
            .billing_cycle
            .and_then(|c| c.billing_period_end)
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(&s).ok().map(|d| d.timestamp_millis()));
        if used_fraction.is_none() && used_cents.is_none() && limit_cents.is_none() {
            return Ok(None);
        }
        Ok(Some(UsageReport {
            provider: "xai-oauth".into(),
            account: oauth.email.clone().or(oauth.account_id.clone()).unwrap_or_else(|| "account".into()),
            fetched_at: chrono::Utc::now().timestamp_millis(),
            limits: vec![UsageLimit {
                id: "xai-oauth:monthly".into(),
                label: "Grok Credits".into(),
                tier: None,
                scope: UsageScope {
                    provider: "xai-oauth".into(),
                    account_id: oauth.account_id.clone(),
                    project_id: None,
                    org_id: None,
                    model_id: None,
                    tier: None,
                    window_id: Some("monthly".into()),
                    shared: true,
                },
                window: Some(UsageWindow {
                    id: "monthly".into(),
                    label: "Monthly".into(),
                    duration_ms: None,
                    resets_at,
                }),
                amount: UsageAmount {
                    used: used_cents,
                    limit: limit_cents,
                    remaining: match (used_cents, limit_cents) {
                        (Some(u), Some(l)) => Some((l - u).max(0.0)),
                        _ => None,
                    },
                    used_fraction,
                    remaining_fraction: used_fraction.map(|v| (1.0 - v).max(0.0)),
                    unit: UsageUnit::Usd,
                },
                status: match used_fraction {
                    Some(f) if f >= 1.0 => UsageStatus::Exhausted,
                    Some(f) if f >= 0.9 => UsageStatus::Warning,
                    Some(_) => UsageStatus::Ok,
                    None => UsageStatus::Unknown,
                },
                notes: vec!["Undocumented Grok CLI billing endpoint".into()],
            }],
            notes: Vec::new(),
        }))
    }
}
