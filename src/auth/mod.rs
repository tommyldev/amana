//! atop's own provider credentials. Stored independently of oh-my-pi (atop
//! never reads omp's credential store); `atop login <provider>` mints these
//! via API-key entry or an OAuth flow and persists them in atop's secret store.
use serde::{Deserialize, Serialize};

pub mod oauth;
pub mod store;

/// One credential for a provider account. Serialized as tagged JSON in the
/// secret store, e.g. `{"type":"oauth","access":"…",...}`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Credential {
    ApiKey(ApiKeyCred),
    Oauth(OAuthCred),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiKeyCred {
    pub key: String,
    /// Optional human label (e.g. a workspace name) for multi-key providers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enterprise_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthCred {
    pub access: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh: Option<String>,
    /// Epoch ms when the access token expires (mint time already subtracts skew).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enterprise_url: Option<String>,
}

impl Credential {
    /// Stable identity used to dedupe accounts within a provider.
    pub fn identity(&self) -> Option<String> {
        match self {
            Credential::ApiKey(c) => c.account.clone(),
            Credential::Oauth(c) => c
                .email
                .clone()
                .or_else(|| c.account_id.clone())
                .or_else(|| c.project_id.clone()),
        }
    }

    /// Display label for the account row.
    pub fn account_label(&self) -> String {
        match self {
            Credential::ApiKey(c) => c.account.clone().unwrap_or_else(|| "api key".into()),
            Credential::Oauth(c) => c
                .email
                .clone()
                .or_else(|| c.account_id.clone())
                .or_else(|| c.project_id.clone())
                .unwrap_or_else(|| "account".into()),
        }
    }

    /// True when an OAuth access token is past (or within skew of) expiry.
    pub fn needs_refresh(&self, now_ms: i64) -> bool {
        match self {
            Credential::Oauth(c) => c.expires.map(|e| now_ms >= e).unwrap_or(false),
            Credential::ApiKey(_) => false,
        }
    }
}
