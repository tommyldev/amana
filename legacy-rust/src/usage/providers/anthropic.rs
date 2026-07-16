//! Anthropic (Claude Pro/Max) usage fetcher — OAuth.
//! Ports oh-my-pi's `claudeUsageProvider`: GET api.anthropic.com/api/oauth/usage
//! with the OAuth bearer token; surfaces the 5h + 7d (+ opus/sonnet) buckets.
use anyhow::Result;
use serde::Deserialize;

use super::super::http;
use super::super::{UsageAmount, UsageFetcher, UsageLimit, UsageReport, UsageScope, UsageUnit, UsageWindow};
use crate::auth::Credential;

const ENDPOINT: &str = "https://api.anthropic.com/api/oauth/usage";
const FIVE_HOURS_MS: i64 = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS: i64 = 7 * 24 * 60 * 60 * 1000;
// Mirror claude-cli's beta header so the OAuth usage endpoint accepts us.
const ANTHROPIC_BETA: &str =
    "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27";

#[derive(Deserialize, Default)]
struct Bucket {
    utilization: Option<f64>,
    resets_at: Option<String>,
}

#[derive(Deserialize, Default)]
struct UsageResponse {
    five_hour: Option<Bucket>,
    seven_day: Option<Bucket>,
    seven_day_opus: Option<Bucket>,
    seven_day_sonnet: Option<Bucket>,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    account_id: Option<String>,
}

fn parse_iso(s: &Option<String>) -> Option<i64> {
    let s = s.as_deref()?;
    chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp_millis())
}

fn amount(util: Option<f64>) -> Option<UsageAmount> {
    let u = util?;
    let clamped = u.clamp(0.0, 100.0);
    let frac = clamped / 100.0;
    Some(UsageAmount {
        used: Some(clamped),
        limit: Some(100.0),
        remaining: Some((100.0 - clamped).max(0.0)),
        used_fraction: Some(frac),
        remaining_fraction: Some((1.0 - frac).max(0.0)),
        unit: UsageUnit::Percent,
    })
}

struct LimitSpec {
    id: &'static str,
    label: &'static str,
    window_id: &'static str,
    window_label: &'static str,
    duration_ms: i64,
    tier: Option<&'static str>,
}

fn build_limit(spec: &LimitSpec, bucket: &Option<Bucket>) -> Option<UsageLimit> {
    let bucket = bucket.as_ref()?;
    let amt = amount(bucket.utilization)?;
    let status = super::zai::status_of(amt.used_fraction);
    Some(UsageLimit {
        id: spec.id.into(),
        label: spec.label.into(),
        tier: spec.tier.map(|s| s.into()),
        scope: UsageScope {
            provider: "anthropic".into(),
            account_id: None,
            project_id: None,
            org_id: None,
            model_id: None,
            tier: spec.tier.map(|s| s.into()),
            window_id: Some(spec.window_id.into()),
            shared: spec.tier.is_none(),
        },
        window: Some(UsageWindow {
            id: spec.window_id.into(),
            label: spec.window_label.into(),
            duration_ms: Some(spec.duration_ms),
            resets_at: parse_iso(&bucket.resets_at),
        }),
        amount: amt,
        status,
        notes: Vec::new(),
    })
}

fn parse(body: &UsageResponse) -> Vec<UsageLimit> {
    let specs = [
        (LimitSpec { id: "anthropic:5h", label: "Claude 5 Hour", window_id: "5h", window_label: "5 Hour", duration_ms: FIVE_HOURS_MS, tier: None }, &body.five_hour),
        (LimitSpec { id: "anthropic:7d", label: "Claude 7 Day", window_id: "7d", window_label: "7 Day", duration_ms: SEVEN_DAYS_MS, tier: None }, &body.seven_day),
        (LimitSpec { id: "anthropic:7d:opus", label: "Claude 7 Day (Opus)", window_id: "7d", window_label: "7 Day", duration_ms: SEVEN_DAYS_MS, tier: Some("opus") }, &body.seven_day_opus),
        (LimitSpec { id: "anthropic:7d:sonnet", label: "Claude 7 Day (Sonnet)", window_id: "7d", window_label: "7 Day", duration_ms: SEVEN_DAYS_MS, tier: Some("sonnet") }, &body.seven_day_sonnet),
    ];
    specs.iter().filter_map(|(spec, bucket)| build_limit(spec, bucket)).collect()
}

pub struct AnthropicFetcher;

#[async_trait::async_trait]
impl UsageFetcher for AnthropicFetcher {
    fn provider(&self) -> &'static str {
        "anthropic"
    }

    async fn fetch(
        &self,
        cred: &Credential,
        client: &reqwest::Client,
    ) -> Result<Option<UsageReport>> {
        let Credential::Oauth(oauth) = cred else { return Ok(None) };
        let token = oauth.access.clone();
        let resp = http::send_retry(
            || {
                client
                    .get(ENDPOINT)
                    .header("authorization", format!("Bearer {token}"))
                    .header("accept", "application/json, text/plain, */*")
                    .header("anthropic-beta", ANTHROPIC_BETA)
                    .header("content-type", "application/json")
                    .header("user-agent", "claude-cli/2.1.63 (external, cli)")
            },
            3,
        )
        .await?;
        if !resp.status().is_success() {
            anyhow::bail!("anthropic usage HTTP {}", resp.status());
        }
        let body: UsageResponse = resp.json().await?;
        let limits = parse(&body);
        if limits.is_empty() {
            return Ok(None);
        }
        let account = oauth
            .email
            .clone()
            .or_else(|| body.email.clone())
            .or_else(|| oauth.account_id.clone())
            .or_else(|| body.account_id.clone())
            .unwrap_or_else(|| "account".into());
        Ok(Some(UsageReport {
            provider: "anthropic".into(),
            account,
            fetched_at: chrono::Utc::now().timestamp_millis(),
            limits,
            notes: Vec::new(),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::UsageStatus;

    #[test]
    fn parses_buckets_with_reset_times() {
        let body: UsageResponse = serde_json::from_value(serde_json::json!({
            "five_hour": { "utilization": 61.0, "resets_at": "2026-06-27T01:00:00Z" },
            "seven_day": { "utilization": 31.0, "resets_at": "2026-06-29T00:00:00Z" },
            "seven_day_sonnet": { "utilization": 0.0, "resets_at": "2026-06-29T00:00:00Z" }
        }))
        .unwrap();
        let limits = parse(&body);
        // 5h + 7d + 7d:sonnet present; opus absent.
        assert_eq!(limits.len(), 3);
        let five = limits.iter().find(|l| l.id == "anthropic:5h").unwrap();
        assert!((five.amount.used_fraction.unwrap() - 0.61).abs() < 1e-9);
        assert_eq!(five.amount.unit, UsageUnit::Percent);
        assert!(five.window.as_ref().unwrap().resets_at.is_some());
        assert_eq!(five.status, UsageStatus::Ok);
    }
}
