use anyhow::{anyhow, Result};
use serde::Deserialize;

use super::{callback, pkce, post_json, random_state};
use crate::auth::{store, Credential, OAuthCred};
use crate::db::Db;
use crate::usage::http;

const CLIENT_ID: &str = "GOOGLE_CLIENT_ID_REDACTED";
const CLIENT_SECRET: &str = "GOOGLE_CLIENT_SECRET_REDACTED";
const AUTHORIZE_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const USERINFO_URL: &str = "https://www.googleapis.com/oauth2/v2/userinfo";
const CALLBACK_PORT: u16 = 51121;
const CALLBACK_PATH: &str = "/callback";
const REDIRECT_URI: &str = "http://127.0.0.1:51121/callback";
const SCOPES: &str = "openid email profile https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs";
const SKEW_MS: i64 = 60 * 1000;

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    expires_in: i64,
}

#[derive(Deserialize)]
struct UserInfo {
    #[serde(default)]
    email: Option<String>,
}

fn authorize_url(challenge: &str, state: &str) -> String {
    let scope = percent_encode(SCOPES);
    let redirect = percent_encode(REDIRECT_URI);
    format!(
        "{AUTHORIZE_URL}?client_id={CLIENT_ID}&response_type=code&redirect_uri={redirect}&scope={scope}&access_type=offline&prompt=consent&code_challenge={challenge}&code_challenge_method=S256&state={state}"
    )
}

fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for b in value.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            b' ' => out.push_str("%20"),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn to_cred(token: TokenResponse, prev_refresh: Option<String>, email: Option<String>) -> OAuthCred {
    OAuthCred {
        access: token.access_token,
        refresh: token.refresh_token.or(prev_refresh),
        expires: Some(chrono::Utc::now().timestamp_millis() + token.expires_in * 1000 - SKEW_MS),
        account_id: email.clone(),
        email,
        project_id: None,
        enterprise_url: None,
    }
}

pub async fn login(db: &Db, provider: &str) -> Result<()> {
    let pkce = pkce()?;
    let state = random_state()?;
    let url = authorize_url(&pkce.challenge, &state);
    let (code, returned_state) = callback::run(CALLBACK_PORT, CALLBACK_PATH, &state, &url).await?;
    let client = http::client();
    let mut cred = exchange(&client, &code, &returned_state, &pkce.verifier).await?;
    cred.email = fetch_email(&client, &cred.access).await?.or(cred.email);
    if (provider == "google-antigravity" || provider == "google-gemini-cli") && cred.project_id.is_none() {
        let project: String = dialoguer::Input::new()
            .with_prompt(if provider == "google-antigravity" {
                "Antigravity project id"
            } else {
                "Gemini CLI project id"
            })
            .interact_text()?;
        let trimmed = project.trim().to_string();
        if !trimmed.is_empty() {
            cred.project_id = Some(trimmed);
        }
    }
    let label = cred.email.clone().unwrap_or_else(|| "account".into());
    store::upsert(db, provider, Credential::Oauth(cred))?;
    println!("{provider}: authenticated ({label})");
    Ok(())
}

async fn exchange(client: &reqwest::Client, code: &str, state: &str, verifier: &str) -> Result<OAuthCred> {
    let body = serde_json::json!({
        "grant_type": "authorization_code",
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "code": code,
        "state": state,
        "redirect_uri": REDIRECT_URI,
        "code_verifier": verifier,
    });
    let text = post_json(client, TOKEN_URL, &body).await?;
    let token: TokenResponse =
        serde_json::from_str(&text).map_err(|e| anyhow!("bad token JSON: {e}; body={text}"))?;
    Ok(to_cred(token, None, None))
}

pub async fn refresh(client: &reqwest::Client, refresh_token: &str, prev: &OAuthCred) -> Result<OAuthCred> {
    let body = serde_json::json!({
        "grant_type": "refresh_token",
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "refresh_token": refresh_token,
    });
    let text = post_json(client, TOKEN_URL, &body).await?;
    let token: TokenResponse =
        serde_json::from_str(&text).map_err(|e| anyhow!("bad refresh JSON: {e}; body={text}"))?;
    let mut cred = to_cred(token, Some(refresh_token.to_string()), prev.email.clone());
    cred.project_id = prev.project_id.clone();
    cred.enterprise_url = prev.enterprise_url.clone();
    cred.account_id = prev.account_id.clone().or(prev.email.clone());
    Ok(cred)
}

async fn fetch_email(client: &reqwest::Client, access_token: &str) -> Result<Option<String>> {
    let resp = client
        .get(USERINFO_URL)
        .header("authorization", format!("Bearer {access_token}"))
        .header("accept", "application/json")
        .send()
        .await?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    let body: UserInfo = resp.json().await?;
    Ok(body.email.filter(|s| !s.is_empty()))
}
