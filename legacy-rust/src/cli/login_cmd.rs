//! `atop login [provider]` — authenticate a provider with atop's own
//! credentials. API-key providers prompt for the key; OAuth providers open
//! the browser and run atop's own PKCE callback server.
use anyhow::{anyhow, Result};
use dialoguer::{FuzzySelect, Input, Password};

use crate::auth::oauth::anthropic as anthropic_oauth;
use crate::auth::oauth::google as google_oauth;
use crate::auth::{store as cred_store, ApiKeyCred, Credential};
use crate::cli::validate::validate_admin_key;
use crate::config::{AuthMethod, Config, Paths, ProviderCfg};
use crate::db::Db;
use crate::usage;
/// Provider authentication kind, used to dispatch + validate the CLI.
enum LoginKind {
    ApiKey,
    OAuth,
    AdminKey,
}

fn kind_for(provider: &str) -> Option<LoginKind> {
    match provider {
        "zai" => Some(LoginKind::ApiKey),
        "github-copilot" => Some(LoginKind::ApiKey),
        "openai-codex" => Some(LoginKind::ApiKey),
        "minimax-code" => Some(LoginKind::ApiKey),
        "minimax-code-cn" => Some(LoginKind::ApiKey),
        "anthropic" => Some(LoginKind::OAuth),
        "google-antigravity" => Some(LoginKind::OAuth),
        "google-gemini-cli" => Some(LoginKind::OAuth),
        "kimi-code" => Some(LoginKind::OAuth),
        "xai-oauth" => Some(LoginKind::OAuth),
        "openai-api" | "anthropic-api" => Some(LoginKind::AdminKey),
        _ => None,
    }
}


/// All providers atop currently supports for `atop login`: live usage
/// providers plus the admin-API ingestion ids.
fn loginable() -> Vec<&'static str> {
    let mut v = usage::supported().to_vec();
    v.push("openai-api");
    v.push("anthropic-api");
    v
}

pub async fn run(provider: Option<String>, paths: &Paths, cfg: &Config, db: &Db) -> Result<()> {
    let id = match provider {
        Some(p) => p,
        None => pick_provider()?,
    };
    match kind_for(&id) {
        Some(LoginKind::ApiKey) => api_key_flow(db, &id).await,
        Some(LoginKind::OAuth) => oauth_flow(db, &id).await,
        Some(LoginKind::AdminKey) => admin_key_flow(db, paths, cfg, &id).await,
        None => Err(anyhow!(
            "atop has no login flow for `{id}` yet. supported: {}",
            loginable().join(", ")
        )),
    }
}
fn pick_provider() -> Result<String> {
    let providers = loginable();
    if providers.is_empty() {
        return Err(anyhow!("no providers support login yet"));
    }
    let labels: Vec<String> = providers
        .iter()
        .map(|id| {
            let label = crate::registry::by_id(id).map(|p| p.label).unwrap_or(id);
            format!("{} ({})", id, label)
        })
        .collect();
    let sel = FuzzySelect::new()
        .with_prompt("Provider to authenticate (type to filter)")
        .items(&labels)
        .interact_opt()?;
    let Some(sel) = sel else {
        return Err(anyhow!("provider selection cancelled"));
    };
    Ok(providers[sel].to_string())
}


async fn api_key_flow(db: &Db, id: &str) -> Result<()> {
    let key = Password::new()
        .with_prompt(format!("{id} API key"))
        .interact()?;
    let account = {
        let value: String = Input::new()
            .allow_empty(true)
            .with_prompt("Account label (optional)")
            .interact_text()?;
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() { None } else { Some(trimmed) }
    };
    let enterprise_url = if id == "github-copilot" {
        let value: String = Input::new()
            .allow_empty(true)
            .with_prompt("GitHub Enterprise API base URL (optional)")
            .interact_text()?;
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() { None } else { Some(trimmed) }
    } else {
        None
    };
    let cred = Credential::ApiKey(ApiKeyCred { key, account, enterprise_url });
    health_check(db, id, &cred).await?;
    cred_store::upsert(db, id, cred)?;
    println!("{id}: stored api key in atop's secret store (health-check ok)");
    Ok(())
}
async fn oauth_flow(db: &Db, id: &str) -> Result<()> {
    match id {
        "anthropic" => {
            anthropic_oauth::login(db).await?;
            // Re-validate the just-saved credential so login fails loudly on
            // 401s (revoked token, wrong account, etc.).
            let creds = cred_store::load(db, "anthropic")?;
            if let Some(c) = creds.last() {
                health_check(db, "anthropic", c).await?;
                println!("anthropic: health-check ok");
            }
            Ok(())
        }
        "google-antigravity" => {
            google_oauth::login(db, "google-antigravity").await?;
            let creds = cred_store::load(db, "google-antigravity")?;
            if let Some(c) = creds.last() {
                health_check(db, "google-antigravity", c).await?;
                println!("google-antigravity: health-check ok");
            }
            Ok(())
        }
        "google-gemini-cli" => {
            google_oauth::login(db, "google-gemini-cli").await?;
            let creds = cred_store::load(db, "google-gemini-cli")?;
            if let Some(c) = creds.last() {
                health_check(db, "google-gemini-cli", c).await?;
                println!("google-gemini-cli: health-check ok");
            }
            Ok(())
        }
        _ => Err(anyhow!("atop has no OAuth flow for `{id}` yet")),
    }
}
async fn admin_key_flow(db: &Db, paths: &Paths, cfg: &Config, id: &str) -> Result<()> {
    let def = crate::registry::by_id(id)
        .ok_or_else(|| anyhow!("unknown provider: {id}"))?;
    let key = Password::new()
        .with_prompt(format!("Admin key for {id}"))
        .interact()?;
    validate_admin_key(def.source_kind, &key).await?;
    db.set_secret(id, &key)?;
    let mut cfg = cfg.clone();
    let mut prov = ProviderCfg::for_id(id);
    prov.auth_method = AuthMethod::ApiKey;
    prov.enabled = true;
    cfg.upsert_provider(prov);
    Config::save(&paths.config_path, &cfg)?;
    println!("{id}: enabled");
    Ok(())
}


/// Ping the provider with the given credential. Errors include the provider
/// name and a short, user-readable message.
async fn health_check(db: &Db, id: &str, cred: &Credential) -> Result<()> {
    let fetcher = usage::fetcher_for(id)
        .ok_or_else(|| anyhow!("atop has no fetcher for `{id}`"))?;
    let client = usage::http::client();
    match fetcher.validate(db, cred, &client).await {
        Ok(()) => Ok(()),
        Err(e) => Err(anyhow!("{id} health-check failed: {e}")),
    }
}
