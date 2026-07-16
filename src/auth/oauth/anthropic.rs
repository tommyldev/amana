//! Anthropic (Claude Pro/Max) OAuth — atop's own login + token refresh.
//! Ports oh-my-pi's `AnthropicOAuthFlow`: PKCE authorize via claude.ai, code
//! exchange + refresh against api.anthropic.com/v1/oauth/token.
use anyhow::{anyhow, Result};
use serde::Deserialize;

use super::{callback, pkce, post_json, random_state};
use crate::auth::{store, Credential, OAuthCred};
use crate::db::Db;
use crate::usage::http;


const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL: &str = "https://claude.ai/oauth/authorize";
const TOKEN_URL: &str = "https://api.anthropic.com/v1/oauth/token";
const CALLBACK_PORT: u16 = 54545;
const CALLBACK_PATH: &str = "/callback";
const REDIRECT_URI: &str = "http://localhost:54545/callback";
const REDIRECT_URI_ENC: &str = "http%3A%2F%2Flocalhost%3A54545%2Fcallback";
const SCOPES_ENC: &str = "org%3Acreate_api_key%20user%3Aprofile%20user%3Ainference";
const SKEW_MS: i64 = 5 * 60 * 1000;

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: i64,
    account: Option<Account>,
}

#[derive(Deserialize)]
struct Account {
    uuid: Option<String>,
    email_address: Option<String>,
}

fn authorize_url(challenge: &str, state: &str) -> String {
    format!(
        "{AUTHORIZE_URL}?code=true&client_id={CLIENT_ID}&response_type=code\
&redirect_uri={REDIRECT_URI_ENC}&scope={SCOPES_ENC}\
&code_challenge={challenge}&code_challenge_method=S256&state={state}"
    )
}

fn to_cred(t: TokenResponse, prev_refresh: Option<String>) -> OAuthCred {
    let (account_id, email) = match t.account {
        Some(a) => (
            a.uuid.filter(|s| !s.is_empty()),
            a.email_address.filter(|s| !s.is_empty()),
        ),
        None => (None, None),
    };
    OAuthCred {
        access: t.access_token,
        refresh: t.refresh_token.or(prev_refresh),
        expires: Some(chrono::Utc::now().timestamp_millis() + t.expires_in * 1000 - SKEW_MS),
        account_id,
        email,
        project_id: None,
        enterprise_url: None,
    }
}
/// Run the full browser OAuth login and persist the credential.
pub async fn login(db: &Db) -> Result<()> {
    let pkce = pkce()?;
    let state = random_state()?;
    let url = authorize_url(&pkce.challenge, &state);
    let (code, returned_state) = callback::run(CALLBACK_PORT, CALLBACK_PATH, &state, &url).await?;
    let client = http::client();
    let cred = exchange(&client, &code, &returned_state, &pkce.verifier).await?;
    let label = cred
        .email
        .clone()
        .or_else(|| cred.account_id.clone())
        .unwrap_or_else(|| "account".into());
    store::upsert(db, "anthropic", Credential::Oauth(cred))?;
    println!("anthropic: authenticated ({label})");
    Ok(())
}

async fn exchange(
    client: &reqwest::Client,
    code: &str,
    state: &str,
    verifier: &str,
) -> Result<OAuthCred> {
    // claude.ai may hand back the code as `code#state`.
    let (code, state) = match code.split_once('#') {
        Some((c, s)) if !s.is_empty() => (c, s),
        _ => (code, state),
    };
    let body = serde_json::json!({
        "grant_type": "authorization_code",
        "client_id": CLIENT_ID,
        "code": code,
        "state": state,
        "redirect_uri": REDIRECT_URI,
        "code_verifier": verifier,
    });
    let text = post_json(client, TOKEN_URL, &body).await?;
    let token: TokenResponse =
        serde_json::from_str(&text).map_err(|e| anyhow!("bad token JSON: {e}; body={text}"))?;
    Ok(to_cred(token, None))
}

/// Exchange a refresh token for a fresh access token.
pub async fn refresh(client: &reqwest::Client, refresh_token: &str) -> Result<OAuthCred> {
    let body = serde_json::json!({
        "grant_type": "refresh_token",
        "client_id": CLIENT_ID,
        "refresh_token": refresh_token,
    });
    let text = post_json(client, TOKEN_URL, &body).await?;
    let token: TokenResponse =
        serde_json::from_str(&text).map_err(|e| anyhow!("bad refresh JSON: {e}; body={text}"))?;
    Ok(to_cred(token, Some(refresh_token.to_string())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorize_url_has_required_params() {
        let u = authorize_url("CHAL", "STATE");
        assert!(u.starts_with("https://claude.ai/oauth/authorize?"));
        assert!(u.contains("client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e"));
        assert!(u.contains("code_challenge=CHAL"));
        assert!(u.contains("code_challenge_method=S256"));
        assert!(u.contains("state=STATE"));
        assert!(u.contains(REDIRECT_URI_ENC));
    }

    #[test]
    fn token_response_maps_to_cred() {
        let t: TokenResponse = serde_json::from_value(serde_json::json!({
            "access_token": "at", "refresh_token": "rt", "expires_in": 3600,
            "account": { "uuid": "u1", "email_address": "me@x.com" }
        }))
        .unwrap();
        let c = to_cred(t, None);
        assert_eq!(c.access, "at");
        assert_eq!(c.email.as_deref(), Some("me@x.com"));
        assert_eq!(c.account_id.as_deref(), Some("u1"));
        assert!(c.expires.unwrap() > chrono::Utc::now().timestamp_millis());
    }
}
