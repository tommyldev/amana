use anyhow::{Context, Result};
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

mod defaults;
mod provider;

pub use provider::{AuthMethod, LimitsCfg, ProviderCfg, WindowCfg, WindowTypeCfg};

#[cfg(test)]
mod tests;

/// Resolved filesystem locations for atop. `ATOP_CONFIG_DIR` and
/// `ATOP_DATA_DIR` override the XDG-derived defaults and are the
/// mechanism tests use to stay hermetic.
pub struct Paths {
    pub config_path: PathBuf,
    pub data_dir: PathBuf,
}

impl Paths {
    pub fn resolve() -> Result<Self> {
        let (config_path, data_dir) = match (
            std::env::var_os("ATOP_CONFIG_DIR"),
            std::env::var_os("ATOP_DATA_DIR"),
        ) {
            (Some(c), Some(d)) => (
                PathBuf::from(c).join("config.toml"),
                PathBuf::from(d),
            ),
            (Some(c), None) => (
                PathBuf::from(c).join("config.toml"),
                project_dirs()?.data_dir().to_path_buf(),
            ),
            (None, Some(d)) => (
                project_dirs()?.config_dir().join("config.toml"),
                PathBuf::from(d),
            ),
            (None, None) => {
                let p = project_dirs()?;
                (p.config_dir().join("config.toml"), p.data_dir().to_path_buf())
            }
        };
        Ok(Self { config_path, data_dir })
    }

    pub fn data_path(&self) -> PathBuf {
        self.data_dir.join("atop.db")
    }
}

fn project_dirs() -> Result<ProjectDirs> {
    ProjectDirs::from("dev", "atop", "atop")
        .ok_or_else(|| anyhow::anyhow!("could not determine XDG directories"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub ui: UiCfg,
    #[serde(default)]
    pub alerts: AlertsCfg,
    #[serde(default)]
    pub providers: Vec<ProviderCfg>,
}


impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        if !path.exists() {
            let cfg = Config::default();
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).ok();
            }
            std::fs::write(path, toml::to_string(&cfg)?)?;
            return Ok(cfg);
        }
        let text = std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
        let cfg: Config = toml::from_str(&text).with_context(|| format!("parse {}", path.display()))?;
        let mut merged = cfg;
        let default = Config::default();
        for d in default.providers {
            if !merged.providers.iter().any(|p| p.id == d.id) {
                merged.providers.push(d);
            }
        }
        Ok(merged)
    }

    pub fn save(path: &Path, cfg: &Config) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        std::fs::write(path, toml::to_string(cfg)?)?;
        Ok(())
    }

    pub fn upsert_provider(&mut self, prov: ProviderCfg) {
        if let Some(existing) = self.providers.iter_mut().find(|p| p.id == prov.id) {
            existing.enabled = prov.enabled;
            existing.auth_method = prov.auth_method;
            if prov.usage_window.r#type != WindowTypeCfg::Rolling || prov.usage_window.duration.is_some() {
                existing.usage_window = prov.usage_window;
            }
            if prov.limits.window_token_limit.is_some() || prov.limits.monthly_cost.is_some() {
                existing.limits = prov.limits;
            }
        } else {
            self.providers.push(prov);
        }
    }

    pub fn upsert_provider_window(&mut self, id: &str, w: WindowCfg) {
        if let Some(p) = self.providers.iter_mut().find(|p| p.id == id) {
            p.usage_window = w;
        } else {
            self.providers.push(ProviderCfg {
                id: id.into(),
                enabled: true,
                auth_method: AuthMethod::None,
                usage_window: w,
                extra_windows: Vec::new(),
                limits: LimitsCfg::default(),
            });
        }
    }

    pub fn upsert_provider_limit(&mut self, id: &str, cost: Option<f64>, tokens: Option<u64>) {
        if let Some(p) = self.providers.iter_mut().find(|p| p.id == id) {
            if cost.is_some() { p.limits.monthly_cost = cost; }
            if tokens.is_some() { p.limits.window_token_limit = tokens; }
        } else {
            self.providers.push(ProviderCfg {
                id: id.into(),
                enabled: true,
                auth_method: AuthMethod::None,
                usage_window: WindowCfg {
                    r#type: WindowTypeCfg::Rolling,
                    duration: Some("5h".into()),
                },
                extra_windows: Vec::new(),
                limits: LimitsCfg { window_token_limit: tokens, monthly_cost: cost },
            });
        }
    }

    pub fn provider(&self, id: &str) -> Option<&ProviderCfg> {
        self.providers.iter().find(|p| p.id == id)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UiCfg {
    #[serde(default = "default_refresh")]
    pub refresh_interval_seconds: u64,
}

impl Default for UiCfg {
    fn default() -> Self { Self { refresh_interval_seconds: default_refresh() } }
}

fn default_refresh() -> u64 { 60 }

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AlertsCfg {
    pub global_daily_token_limit: Option<u64>,
}
