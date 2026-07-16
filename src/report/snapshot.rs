use chrono::{DateTime, Utc};

use crate::config::{Config, ProviderCfg, WindowCfg, WindowTypeCfg};
use crate::db::Db;
use crate::model::UsageAggregate;
use crate::registry;
use crate::window::{self, ActiveWindow, WindowKind};

/// One reset window for a provider. A provider may track several at once
/// (e.g. a rolling 5h burst window plus a weekly cap).
pub struct WindowView {
    pub desc: String,
    /// `None` when the window config is invalid (e.g. bad duration string).
    pub active: Option<ActiveWindow>,
    pub usage: UsageAggregate,
    /// Set only for the primary window when the user configured a token limit.
    pub token_limit: Option<u64>,
    /// 0.0 unless `token_limit` is set.
    pub pct: f64,
    /// Set when the window config is invalid; carries the parse error.
    pub error: Option<String>,
}

/// One provider's resolved state at a moment in time. Built once per render
/// and shared by both the CLI renderers and the TUI.
pub struct ProviderView {
    pub id: String,
    pub label: String,
    pub enabled: bool,
    pub status: String,
    /// Always >= 1 entry; `windows[0]` is the primary window.
    pub windows: Vec<WindowView>,
    pub monthly_cost_limit: Option<f64>,
}

impl ProviderView {
    pub fn primary(&self) -> &WindowView {
        &self.windows[0]
    }

    /// The window whose reset is nearest in the future; falls back to the
    /// primary window when none has a valid active window.
    pub fn soonest(&self) -> &WindowView {
        self.windows
            .iter()
            .filter(|w| w.active.is_some())
            .min_by_key(|w| w.active.as_ref().unwrap().next_reset)
            .unwrap_or(&self.windows[0])
    }
}

pub struct Snapshot {
    pub now: DateTime<Utc>,
    pub today: UsageAggregate,
    pub providers: Vec<ProviderView>,
}

pub fn build(db: &Db, cfg: &Config, now: DateTime<Utc>) -> Snapshot {
    let today = db.todays_totals(now.timestamp_millis()).unwrap_or_default();
    let providers = cfg
        .providers
        .iter()
        .map(|prov| build_view(db, prov, now))
        .collect();
    Snapshot { now, today, providers }
}

fn build_view(db: &Db, prov: &ProviderCfg, now: DateTime<Utc>) -> ProviderView {
    let status = db
        .provider_status(&prov.id)
        .ok()
        .flatten()
        .unwrap_or_else(|| "ok".into());
    let sources = sources_for(&prov.id);
    let omp_provider = registry::by_id(&prov.id).and_then(|d| d.omp_provider);

    let cfgs = std::iter::once(&prov.usage_window).chain(prov.extra_windows.iter());
    let windows: Vec<WindowView> = cfgs
        .enumerate()
        .map(|(i, cfg)| {
            let desc = describe_window_cfg(cfg);
            match WindowKind::from_config(cfg) {
                Ok(kind) => {
                    let aw = kind.active_at(now);
                    let usage = db
                        .window_usage(
                            aw.start.timestamp_millis(),
                            aw.next_reset.timestamp_millis(),
                            &sources,
                            omp_provider,
                        )
                        .unwrap_or_default();
                    let token_limit = if i == 0 { prov.limits.window_token_limit } else { None };
                    let pct = crate::report::format::pct_of(usage.total, token_limit);
                    WindowView { desc, active: Some(aw), usage, token_limit, pct, error: None }
                }
                Err(e) => WindowView {
                    desc,
                    active: None,
                    usage: UsageAggregate::default(),
                    token_limit: None,
                    pct: 0.0,
                    error: Some(e.to_string()),
                },
            }
        })
        .collect();

    ProviderView {
        id: prov.id.clone(),
        label: registry::by_id(&prov.id)
            .map(|d| d.label.to_string())
            .unwrap_or_else(|| prov.id.clone()),
        enabled: prov.enabled,
        status,
        windows,
        monthly_cost_limit: prov.limits.monthly_cost,
    }
}

pub fn sources_for(provider_id: &str) -> Vec<String> {
    let def = match registry::by_id(provider_id) {
        Some(d) => d,
        None => return vec![provider_id.to_string()],
    };
    match def.source_kind {
        registry::SourceKind::LogOmp => vec!["omp".into()],
        registry::SourceKind::LogClaudeCode => vec!["claude-code".into()],
        registry::SourceKind::AdminOpenAI => vec!["openai-api".into()],
        registry::SourceKind::AdminAnthropic => vec!["anthropic-api".into()],
    }
}

fn describe_window_cfg(cfg: &WindowCfg) -> String {
    use WindowTypeCfg::*;
    match cfg.r#type {
        Rolling => {
            let d = cfg.duration.as_deref().unwrap_or("5h");
            format!("rolling {d}")
        }
        Daily => "daily".into(),
        Weekly => {
            let w = cfg.duration.as_deref().unwrap_or("mon");
            format!("weekly {w}")
        }
        Monthly => {
            let d = cfg.duration.as_deref().unwrap_or("1");
            format!("monthly {d}")
        }
    }
}

// Kept around for ad-hoc debugging during window-config work.
#[allow(dead_code)]
fn _window_kind_ref(prov: &ProviderCfg) -> anyhow::Result<WindowKind> {
    window::WindowKind::from_config(&prov.usage_window)
}