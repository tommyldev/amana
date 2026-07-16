use super::{AuthMethod, Config, LimitsCfg, ProviderCfg, WindowCfg, WindowTypeCfg};
use crate::registry::{self, Cadence};

impl Default for Config {
    fn default() -> Self {
        // One ProviderCfg per known provider. Window(s) are derived from each
        // provider's reset cadence (see registry::Cadence): dual-limit coding
        // plans get a rolling 5h window plus a weekly cap; gateways reset
        // monthly; Gemini resets daily; aggregates/local track a rolling 5h.
        // Only the raw log aggregates (`omp`, `claude-code`) are enabled by
        // default; everything else is opted in via `atop login`.
        let providers: Vec<ProviderCfg> = registry::KNOWN_PROVIDERS
            .iter()
            .map(|def| {
                let enabled = matches!(def.id, "omp" | "claude-code");
                let auth_method = if def.needs_key {
                    AuthMethod::ApiKey
                } else {
                    AuthMethod::None
                };
                let (usage_window, extra_windows) = match def.cadence {
                    Cadence::FiveHourWeekly => (rolling("5h"), vec![weekly("mon")]),
                    Cadence::FiveHour => (rolling("5h"), vec![]),
                    Cadence::Daily => (daily(), vec![]),
                    Cadence::Monthly => (monthly("1"), vec![]),
                };
                ProviderCfg {
                    id: def.id.into(),
                    enabled,
                    auth_method,
                    usage_window,
                    extra_windows,
                    limits: LimitsCfg::default(),
                }
            })
            .collect();
        Self {
            ui: super::UiCfg::default(),
            alerts: super::AlertsCfg::default(),
            providers,
        }
    }
}

fn rolling(d: &str) -> WindowCfg {
    WindowCfg { r#type: WindowTypeCfg::Rolling, duration: Some(d.into()) }
}

fn weekly(w: &str) -> WindowCfg {
    WindowCfg { r#type: WindowTypeCfg::Weekly, duration: Some(w.into()) }
}

fn daily() -> WindowCfg {
    WindowCfg { r#type: WindowTypeCfg::Daily, duration: None }
}

fn monthly(day: &str) -> WindowCfg {
    WindowCfg { r#type: WindowTypeCfg::Monthly, duration: Some(day.into()) }
}
