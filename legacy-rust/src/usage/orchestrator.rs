//! Orchestrates live usage fetches: walks atop's credentials for each supported
//! provider and returns the union of {@link UsageReport}s plus a per-credential
//! error log so the TUI can show *why* a provider is empty instead of looking
//! blank.
use anyhow::Result;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::task::JoinSet;

use super::{fetcher_for, UsageReport};
use crate::auth::store as cred_store;
use crate::auth::Credential;
use crate::db::Db;
#[derive(Debug, Clone)]
pub struct FetchError {
    pub provider: String,
    pub account: String,
    pub message: String,
}

pub struct FetchResult {
    pub reports: Vec<UsageReport>,
    pub errors: Vec<FetchError>,
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({}): {}", self.provider, self.account, self.message)
    }
}
pub struct Orchestrator {
    client: reqwest::Client,
}

impl Orchestrator {
    pub fn new() -> Self {
        Self { client: super::http::client() }
    }
    /// Fetch live usage for every credential atop has stored for `providers`.
    /// Per-credential errors are collected and returned (not silently dropped):
    /// a single failed provider must not blank the dashboard, but the user
    /// *must* see why a provider returned nothing.
    pub async fn fetch_all(&self, db: &Db, providers: &[&str]) -> Result<FetchResult> {
        let client = Arc::new(self.client.clone());
        let mut set: JoinSet<FetchOutcome> = JoinSet::new();
        let mut errors = Vec::new();
        for &pid in providers {
            let creds = cred_store::load(db, pid).unwrap_or_default();
            for cred in creds {
                // Refresh synchronously on the main task so JoinSet children
                // can own their credentials and never touch the Db. Refresh
                // is rare (only on token expiry) so the lack of fan-out here
                // is fine.
                let account = cred.account_label();
                let cred = match refresh(db, pid, &cred, &self.client).await {
                    Ok(Some(c)) => c,
                    Ok(None) => cred,
                    Err(e) => {
                        errors.push(FetchError {
                            provider: pid.to_string(),
                            account,
                            message: e.to_string(),
                        });
                        continue;
                    }
                };
                let pid = pid.to_string();
                let account = cred.account_label();
                let client = client.clone();
                let db_path = db.path.clone();
                set.spawn(async move {
                    let Some(fetcher) = fetcher_for(&pid) else {
                        return FetchOutcome::Err(FetchError {
                            provider: pid,
                            account,
                            message: "no fetcher registered for this provider".into(),
                        });
                    };
                    let db = crate::db::Db::open(&db_path).map_err(|e| FetchError {
                        provider: pid.clone(),
                        account: account.clone(),
                        message: e.to_string(),
                    });
                    let Ok(local_db) = db else { return FetchOutcome::Err(db.err().unwrap()) };
                    match fetcher.fetch_with_db(&local_db, &cred, &client).await {
                        Ok(Some(r)) => FetchOutcome::Ok(r),
                        Ok(None) => FetchOutcome::Err(FetchError {
                            provider: pid,
                            account,
                            message: "provider returned no usage data".into(),
                        }),
                        Err(e) => FetchOutcome::Err(FetchError {
                            provider: pid,
                            account,
                            message: e.to_string(),
                        }),
                    }
                });
            }
        }
        let mut reports = Vec::new();
        while let Some(res) = set.join_next().await {
            match res {
                Ok(FetchOutcome::Ok(r)) => reports.push(r),
                Ok(FetchOutcome::Err(e)) => errors.push(e),
                Err(join) => errors.push(FetchError {
                    provider: "?".into(),
                    account: "?".into(),
                    message: format!("task panicked: {join}"),
                }),
            }
        }
        Ok(FetchResult { reports, errors })
    }

    /// Per-provider, freshest report; used by the TUI.
    pub fn freshest(reports: &[UsageReport]) -> HashMap<String, UsageReport> {
        let mut by: HashMap<String, UsageReport> = HashMap::new();
        for r in reports {
            match by.get(&r.provider) {
                Some(prev) if prev.fetched_at >= r.fetched_at => {}
                _ => {
                    by.insert(r.provider.clone(), r.clone());
                }
            }
        }
        by
    }
}

enum FetchOutcome {
    Ok(UsageReport),
    Err(FetchError),
}

/// Refresh `cred` in place if it's an expired OAuth token with a refresh
/// token. Returns the new credential on success, or `None` if no refresh
/// was needed / possible. Pre-fetches on the calling task so the spawn
/// pool never touches the Db.
async fn refresh(
    db: &Db,
    provider: &str,
    cred: &Credential,
    client: &reqwest::Client,
) -> Result<Option<Credential>> {
    let now = chrono::Utc::now().timestamp_millis();
    if !cred.needs_refresh(now) {
        return Ok(None);
    }
    let Credential::Oauth(oauth) = cred else { return Ok(None) };
    let Some(refresh_token) = oauth.refresh.as_deref() else { return Ok(None) };
    let refreshed = match provider {
        "anthropic" => crate::auth::oauth::anthropic::refresh(client, refresh_token).await?,
        "google-antigravity" | "google-gemini-cli" => {
            crate::auth::oauth::google::refresh(client, refresh_token, oauth).await?
        }
        _ => return Ok(None),
    };
    let new_cred = Credential::Oauth(refreshed);
    cred_store::upsert(db, provider, new_cred.clone())?;
    Ok(Some(new_cred))
}
