use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub enum AuthMethod {
    #[serde(rename = "api_key")]
    ApiKey,
    #[serde(rename = "oauth")]
    Oauth,
    #[default]
    #[serde(rename = "none")]
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderCfg {
    pub id: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub auth_method: AuthMethod,
    #[serde(default)]
    pub usage_window: WindowCfg,
    #[serde(default)]
    pub extra_windows: Vec<WindowCfg>,
    #[serde(default)]
    pub limits: LimitsCfg,
}

fn yes() -> bool { true }

impl ProviderCfg {
    pub fn for_id(id: &str) -> Self {
        Self {
            id: id.into(),
            enabled: true,
            auth_method: AuthMethod::None,
            usage_window: WindowCfg {
                r#type: WindowTypeCfg::Rolling,
                duration: Some("5h".into()),
            },
            extra_windows: Vec::new(),
            limits: LimitsCfg::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WindowCfg {
    #[serde(rename = "type", default = "default_window_type")]
    pub r#type: WindowTypeCfg,
    /// For Rolling this is a humantime duration (e.g. "5h");
    /// for Weekly this is a weekday string ("mon");
    /// for Monthly this is a day-of-month string ("1".."31").
    #[serde(default)]
    pub duration: Option<String>,
}

fn default_window_type() -> WindowTypeCfg { WindowTypeCfg::Rolling }

impl Default for WindowCfg {
    fn default() -> Self {
        Self { r#type: WindowTypeCfg::Rolling, duration: Some("5h".into()) }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WindowTypeCfg {
    Rolling,
    Daily,
    Weekly,
    Monthly,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LimitsCfg {
    pub window_token_limit: Option<u64>,
    pub monthly_cost: Option<f64>,
}
