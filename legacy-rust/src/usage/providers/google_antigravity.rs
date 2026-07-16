use anyhow::Result;
use serde::Deserialize;
use std::collections::HashMap;

use super::super::{UsageAmount, UsageFetcher, UsageLimit, UsageReport, UsageScope, UsageStatus, UsageUnit, UsageWindow};
use crate::auth::Credential;

const DEFAULT_ENDPOINT: &str = "https://cloudcode-pa.googleapis.com";

#[derive(Debug, Deserialize, Default)]
struct ModelsResponse {
    #[serde(default)]
    models: HashMap<String, ModelInfo>,
}

#[derive(Debug, Deserialize, Default)]
struct ModelInfo {
    #[serde(default)]
    quota_info: Option<QuotaInfo>,
    #[serde(default)]
    quota_infos: Vec<QuotaInfo>,
    #[serde(default)]
    api_provider: Option<String>,
    #[serde(default)]
    model_provider: Option<String>,
}

#[derive(Debug, Deserialize, Clone, Default)]
struct QuotaInfo {
    #[serde(default)]
    remaining_fraction: Option<f64>,
    #[serde(default)]
    reset_time: Option<String>,
    #[serde(default)]
    tier: Option<String>,
    #[serde(default)]
    window_id: Option<String>,
    #[serde(default)]
    window_label: Option<String>,
    #[serde(default)]
    api_provider: Option<String>,
    #[serde(default)]
    model_provider: Option<String>,
}

pub struct GoogleAntigravityFetcher;

#[async_trait::async_trait]
impl UsageFetcher for GoogleAntigravityFetcher {
    fn provider(&self) -> &'static str {
        "google-antigravity"
    }

    async fn fetch(&self, cred: &Credential, client: &reqwest::Client) -> Result<Option<UsageReport>> {
        let Credential::Oauth(oauth) = cred else { return Ok(None) };
        let Some(project_id) = oauth.project_id.clone() else {
            anyhow::bail!("google-antigravity credential missing project_id");
        };
        let access = &oauth.access;
        let endpoint = oauth.enterprise_url.clone().unwrap_or_else(|| DEFAULT_ENDPOINT.into());
        let resp = client
            .post(format!("{}/v1internal:fetchAvailableModels", endpoint.trim_end_matches('/')))
            .header("authorization", format!("Bearer {access}"))
            .header("content-type", "application/json")
            .header("user-agent", "antigravity")
            .json(&serde_json::json!({ "project": project_id }))
            .send()
            .await?;
        if !resp.status().is_success() {
            anyhow::bail!("google-antigravity usage HTTP {}", resp.status());
        }
        let body: ModelsResponse = resp.json().await?;
        let limits = normalize(&body, oauth.account_id.clone(), oauth.project_id.clone());
        if limits.is_empty() {
            return Ok(None);
        }
        Ok(Some(UsageReport {
            provider: "google-antigravity".into(),
            account: oauth.email.clone().or(oauth.account_id.clone()).or(oauth.project_id.clone()).unwrap_or_else(|| "account".into()),
            fetched_at: chrono::Utc::now().timestamp_millis(),
            limits,
            notes: Vec::new(),
        }))
    }
}

fn normalize(body: &ModelsResponse, account_id: Option<String>, project_id: Option<String>) -> Vec<UsageLimit> {
    let mut deduped: HashMap<String, (QuotaInfo, Option<UsageWindow>, String)> = HashMap::new();
    for model in body.models.values() {
        let mut infos = Vec::new();
        if let Some(info) = &model.quota_info {
            infos.push(info.clone());
        }
        infos.extend(model.quota_infos.clone());
        for mut info in infos {
            if info.api_provider.is_none() {
                info.api_provider = model.api_provider.clone();
            }
            if info.model_provider.is_none() {
                info.model_provider = model.model_provider.clone();
            }
            let counter = counter_name(&info);
            let tier = info.tier.clone().unwrap_or_else(|| "default".into()).to_lowercase();
            let window_id = info.window_id.clone().unwrap_or_else(|| "default".into());
            let key = format!("{}|{}|{}", counter.to_lowercase(), tier, window_id);
            let window = parse_window(&info);
            match deduped.get(&key) {
                Some((existing, _, _)) => {
                    let curr = info.remaining_fraction.unwrap_or(0.0);
                    let prev = existing.remaining_fraction.unwrap_or(1.0);
                    if curr < prev {
                        deduped.insert(key, (info, window, counter));
                    }
                }
                None => {
                    deduped.insert(key, (info, window, counter));
                }
            }
        }
    }
    let mut limits: Vec<UsageLimit> = deduped
        .into_iter()
        .map(|(key, (info, window, counter))| build_limit(&key, &counter, info, window, account_id.clone(), project_id.clone()))
        .collect();
    limits.sort_by(|a, b| {
        let af = a.amount.remaining_fraction.unwrap_or(1.0);
        let bf = b.amount.remaining_fraction.unwrap_or(1.0);
        af.partial_cmp(&bf).unwrap_or(std::cmp::Ordering::Equal)
    });
    limits
}

fn counter_name(info: &QuotaInfo) -> String {
    match info.model_provider.as_deref().or(info.api_provider.as_deref()) {
        Some("MODEL_PROVIDER_ANTHROPIC") | Some("API_PROVIDER_ANTHROPIC_VERTEX") => "Anthropic".into(),
        Some("MODEL_PROVIDER_OPENAI") | Some("API_PROVIDER_OPENAI_VERTEX") => "OpenAI".into(),
        Some("MODEL_PROVIDER_GOOGLE") | Some("API_PROVIDER_GOOGLE_GEMINI") => "Google".into(),
        _ => "Default".into(),
    }
}

fn parse_window(info: &QuotaInfo) -> Option<UsageWindow> {
    let reset = info.reset_time.as_deref()?;
    let ts = chrono::DateTime::parse_from_rfc3339(reset).ok()?.timestamp_millis();
    Some(UsageWindow {
        id: info.window_id.clone().unwrap_or_else(|| "default".into()),
        label: info.window_label.clone().unwrap_or_else(|| "Default".into()),
        duration_ms: None,
        resets_at: Some(ts),
    })
}

fn build_limit(
    key: &str,
    counter: &str,
    info: QuotaInfo,
    window: Option<UsageWindow>,
    account_id: Option<String>,
    project_id: Option<String>,
) -> UsageLimit {
    let remaining_fraction = info.remaining_fraction.map(|v| v.clamp(0.0, 1.0)).or_else(|| info.reset_time.as_ref().map(|_| 0.0));
    let used_fraction = remaining_fraction.map(|v| (1.0 - v).clamp(0.0, 1.0));
    UsageLimit {
        id: format!("google-antigravity:{}", key.replace('|', ":")),
        label: format!("Usage ({counter})"),
        tier: info.tier.clone(),
        scope: UsageScope {
            provider: "google-antigravity".into(),
            account_id,
            project_id,
            org_id: None,
            model_id: None,
            tier: info.tier.clone(),
            window_id: info.window_id.clone().or_else(|| window.as_ref().map(|w| w.id.clone())),
            shared: true,
        },
        window,
        amount: UsageAmount {
            used: used_fraction.map(|v| v * 100.0),
            limit: used_fraction.map(|_| 100.0),
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
