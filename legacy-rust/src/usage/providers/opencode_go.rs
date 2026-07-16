use anyhow::Result;

use super::super::{UsageAmount, UsageFetcher, UsageLimit, UsageReport, UsageScope, UsageStatus, UsageUnit, UsageWindow};
use crate::auth::Credential;
use crate::db::Db;

const HOUR_MS: i64 = 60 * 60 * 1000;
const DAY_MS: i64 = 24 * HOUR_MS;

const LIMITS: &[(&str, &str, i64, f64)] = &[
    ("rolling-5h", "5 Hour limit", 5 * HOUR_MS, 12.0),
    ("weekly", "Weekly limit", 7 * DAY_MS, 30.0),
    ("monthly", "Monthly limit", 30 * DAY_MS, 60.0),
];

pub struct OpenCodeGoFetcher;

#[async_trait::async_trait]
impl UsageFetcher for OpenCodeGoFetcher {
    fn provider(&self) -> &'static str {
        "opencode-go"
    }

    async fn fetch(&self, _cred: &Credential, _client: &reqwest::Client) -> Result<Option<UsageReport>> {
        Ok(None)
    }

    async fn fetch_with_db(&self, db: &Db, cred: &Credential, _client: &reqwest::Client) -> Result<Option<UsageReport>> {
        let now = chrono::Utc::now().timestamp_millis();
        let source = vec!["omp".to_string()];
        let mut rows = Vec::new();
        for (id, label, duration_ms, limit_usd) in LIMITS {
            let agg = db.window_usage(now - *duration_ms, now + 1, &source, Some("opencode-go"))?;
            let used = agg.cost;
            let used_fraction = if *limit_usd > 0.0 { Some((used / *limit_usd).clamp(0.0, 1.0)) } else { None };
            rows.push(UsageLimit {
                id: (*id).into(),
                label: (*label).into(),
                tier: Some("OpenCode Go".into()),
                scope: UsageScope {
                    provider: "opencode-go".into(),
                    account_id: Some(cred.account_label()),
                    project_id: None,
                    org_id: None,
                    model_id: None,
                    tier: Some("OpenCode Go".into()),
                    window_id: Some((*id).into()),
                    shared: true,
                },
                window: Some(UsageWindow {
                    id: (*id).into(),
                    label: (*label).replace(" limit", ""),
                    duration_ms: Some(*duration_ms),
                    resets_at: Some(now + *duration_ms),
                }),
                amount: UsageAmount {
                    used: Some(used),
                    limit: Some(*limit_usd),
                    remaining: Some((*limit_usd - used).max(0.0)),
                    used_fraction,
                    remaining_fraction: used_fraction.map(|v| (1.0 - v).max(0.0)),
                    unit: UsageUnit::Usd,
                },
                status: match used_fraction {
                    Some(f) if f >= 1.0 => UsageStatus::Exhausted,
                    Some(f) if f >= 0.8 => UsageStatus::Warning,
                    Some(_) => UsageStatus::Ok,
                    None => UsageStatus::Unknown,
                },
                notes: Vec::new(),
            });
        }
        Ok(Some(UsageReport {
            provider: "opencode-go".into(),
            account: cred.account_label(),
            fetched_at: now,
            limits: rows,
            notes: vec!["OMP-observed spend only; OpenCode usage outside OMP is not included.".into()],
        }))
    }
}
