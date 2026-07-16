//! Real provider usage/quota model + fetchers. Mirrors the normalized shape
//! oh-my-pi exposes (provider → account → limit, each with a real window and
//! amount), but atop fetches it directly with its own credentials.
use crate::auth::Credential;
use crate::db::Db;

pub mod http;
pub mod orchestrator;
#[cfg(test)]
mod orchestrator_test;
pub mod providers;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum UsageUnit {
    Percent,
    Tokens,
    Requests,
    Usd,
    Minutes,
    Bytes,
    #[default]
    Unknown,
}

impl UsageUnit {
    pub fn short(&self) -> &'static str {
        match self {
            UsageUnit::Percent => "%",
            UsageUnit::Tokens => "tok",
            UsageUnit::Requests => "req",
            UsageUnit::Usd => "$",
            UsageUnit::Minutes => "min",
            UsageUnit::Bytes => "B",
            UsageUnit::Unknown => "",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum UsageStatus {
    Ok,
    Warning,
    Exhausted,
    #[default]
    Unknown,
}

#[derive(Debug, Clone)]
pub struct UsageWindow {
    pub id: String,
    pub label: String,
    pub duration_ms: Option<i64>,
    /// Epoch ms when this window resets.
    pub resets_at: Option<i64>,
}

#[derive(Debug, Clone, Default)]
pub struct UsageAmount {
    pub used: Option<f64>,
    pub limit: Option<f64>,
    pub remaining: Option<f64>,
    pub used_fraction: Option<f64>,
    pub remaining_fraction: Option<f64>,
    pub unit: UsageUnit,
}

#[derive(Debug, Clone)]
pub struct UsageScope {
    pub provider: String,
    pub account_id: Option<String>,
    pub project_id: Option<String>,
    pub org_id: Option<String>,
    pub model_id: Option<String>,
    pub tier: Option<String>,
    pub window_id: Option<String>,
    pub shared: bool,
}

#[derive(Debug, Clone)]
pub struct UsageLimit {
    pub id: String,
    pub label: String,
    pub tier: Option<String>,
    pub scope: UsageScope,
    pub window: Option<UsageWindow>,
    pub amount: UsageAmount,
    pub status: UsageStatus,
    pub notes: Vec<String>,
}

/// One provider account's resolved usage at fetch time.
#[derive(Debug, Clone)]
pub struct UsageReport {
    pub provider: String,
    pub account: String,
    pub fetched_at: i64,
    pub limits: Vec<UsageLimit>,
    pub notes: Vec<String>,
}

/// A provider's live usage fetcher. Implementations hit the provider's real
/// quota endpoint with atop's credential and normalize the response.
#[async_trait::async_trait]
pub trait UsageFetcher: Send + Sync {
    fn provider(&self) -> &'static str;
    /// `None` when the provider reports nothing for this credential.
    async fn fetch(
        &self,
        cred: &Credential,
        client: &reqwest::Client,
    ) -> anyhow::Result<Option<UsageReport>>;
    async fn fetch_with_db(
        &self,
        _db: &Db,
        cred: &Credential,
        client: &reqwest::Client,
    ) -> anyhow::Result<Option<UsageReport>> {
        self.fetch(cred, client).await
    }
    /// Lightweight health check used by `atop login` to confirm the credential
    /// is accepted before persisting it. Returns `Ok(())` on success or an
    /// error with a short, user-readable message on failure. Default
    /// implementation just runs `fetch`; fetchers can override with a
    /// cheaper profile call.
    async fn validate(
        &self,
        db: &Db,
        cred: &Credential,
        client: &reqwest::Client,
    ) -> anyhow::Result<()> {
        self.fetch_with_db(db, cred, client)
            .await
            .and_then(|opt| opt.map(|_| ()).ok_or_else(|| anyhow::anyhow!("no usage data returned")))
    }
}

/// The fetcher for a provider id, if atop supports its usage endpoint.
pub fn fetcher_for(provider: &str) -> Option<Box<dyn UsageFetcher>> {
    match provider {
        "zai" => Some(Box::new(providers::zai::ZaiFetcher)),
        "anthropic" => Some(Box::new(providers::anthropic::AnthropicFetcher)),
        "github-copilot" => Some(Box::new(providers::github_copilot::GitHubCopilotFetcher)),
        "google-antigravity" => Some(Box::new(providers::google_antigravity::GoogleAntigravityFetcher)),
        "google-gemini-cli" => Some(Box::new(providers::google_gemini_cli::GoogleGeminiCliFetcher)),
        "openai-codex" => Some(Box::new(providers::openai_codex::OpenAICodexFetcher)),
        "kimi-code" => Some(Box::new(providers::kimi_code::KimiCodeFetcher)),
        "minimax-code" => Some(Box::new(providers::minimax_code::MiniMaxFetcher)),
        "minimax-code-cn" => Some(Box::new(providers::minimax_code::MiniMaxCnFetcher)),
        "opencode-go" => Some(Box::new(providers::opencode_go::OpenCodeGoFetcher)),
        "ollama" => Some(Box::new(providers::ollama::OllamaFetcher)),
        "xai-oauth" => Some(Box::new(providers::xai_oauth::XaiOauthFetcher)),
        _ => None,
    }
}

/// Providers atop can fetch live usage for.
pub fn supported() -> &'static [&'static str] {
    &[
        "zai",
        "anthropic",
        "github-copilot",
        "google-antigravity",
        "google-gemini-cli",
        "openai-codex",
        "kimi-code",
        "minimax-code",
        "minimax-code-cn",
        "opencode-go",
        "ollama",
        "xai-oauth",
    ]
}
