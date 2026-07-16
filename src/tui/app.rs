use std::sync::Arc;

use chrono::{DateTime, Utc};

use crate::config::Config;
use crate::db::Db;
use crate::usage::orchestrator::FetchError;
use crate::usage::UsageReport;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Default view: grouped provider → account → limit view.
    Holistic,
    /// Drill-in for one provider, indexed into the grouped provider list.
    Provider(usize),
    /// Token usage per provider, hourly bucketed.
    Tokens,
    /// Drill-in for one provider's token chart.
    TokenProvider(usize),
}

pub const TOKEN_BUCKETS: usize = 24;
pub const TOKEN_BUCKET_MS: i64 = 3_600_000;

#[derive(Debug, Clone)]
pub struct ProviderSection {
    pub provider_id: String,
    pub provider_label: String,
    pub reports: Vec<UsageReport>,
    pub fetched_at: i64,
}

impl ProviderSection {
    pub fn account_count(&self) -> usize {
        self.reports.len()
    }

    pub fn capacity_summary(&self) -> Vec<WindowCapacity> {
        use std::collections::HashMap;

        let mut grouped: HashMap<String, WindowCapacity> = HashMap::new();
        for report in &self.reports {
            let mut per_account: HashMap<String, f64> = HashMap::new();
            for limit in &report.limits {
                let Some(frac) = limit.amount.used_fraction else { continue };
                let key = limit
                    .scope
                    .window_id
                    .clone()
                    .or_else(|| limit.window.as_ref().map(|w| w.id.clone()))
                    .unwrap_or_else(|| limit.label.clone());
                let label = limit
                    .window
                    .as_ref()
                    .map(|w| w.label.clone())
                    .unwrap_or_else(|| key.clone());
                let duration_ms = limit.window.as_ref().and_then(|w| w.duration_ms);
                match per_account.get(&key) {
                    Some(prev) if *prev >= frac => {}
                    _ => {
                        per_account.insert(key.clone(), frac);
                        grouped.entry(key).or_insert(WindowCapacity {
                            key: label,
                            duration_ms,
                            accounts: 0,
                            used_accounts: 0.0,
                        });
                    }
                }
            }
            for (key, frac) in per_account {
                if let Some(entry) = grouped.get_mut(&key) {
                    entry.accounts += 1;
                    entry.used_accounts += frac;
                }
            }
        }
        let mut out: Vec<WindowCapacity> = grouped.into_values().collect();
        out.sort_by_key(|w| w.duration_ms.unwrap_or(i64::MAX));
        out
    }
}

#[derive(Debug, Clone)]
pub struct WindowCapacity {
    pub key: String,
    pub duration_ms: Option<i64>,
    pub accounts: usize,
    pub used_accounts: f64,
}

impl WindowCapacity {
    pub fn remaining_accounts(&self) -> f64 {
        (self.accounts as f64) - self.used_accounts
    }
}
pub struct App {
    pub cfg: Arc<Config>,
    /// Kept so periodic log-merge paths can still run.
    pub db: Arc<Db>,
    /// Raw live reports, one per account fetch.
    pub reports: Vec<UsageReport>,
    /// Grouped provider sections derived from `reports`.
    pub providers: Vec<ProviderSection>,
    /// Per-credential errors from the last live fetch; rendered in the TUI
    /// footer so the user can see *why* a provider returned nothing.
    pub errors: Vec<FetchError>,
    pub mode: Mode,
    /// Cursor in the report list (holistic view).
    pub selected: usize,
    pub show_help: bool,
    pub syncing: bool,
    pub last_sync_at: Option<DateTime<Utc>>,
    /// Hourly token series grouped by provider.
    pub token_providers: Vec<crate::db::ProviderHourly>,
    /// Per-bucket total tokens across all providers.
    pub token_total: Vec<u64>,
    /// Start timestamp (ms) of the token chart's first bucket.
    pub token_start_ms: i64,
    /// Cursor in the token-provider table.
    pub token_selected: usize,
}

impl App {
    pub fn new(db: Arc<Db>, cfg: Arc<Config>) -> Self {
        Self {
            cfg,
            db,
            reports: Vec::new(),
            providers: Vec::new(),
            errors: Vec::new(),
            mode: Mode::Tokens,
            selected: 0,
            show_help: false,
            syncing: false,
            last_sync_at: None,
            token_providers: Vec::new(),
            token_total: vec![0; TOKEN_BUCKETS],
            token_start_ms: 0,
            token_selected: 0,
        }
    }

    /// Provider ids in report order. Indices into this vec are what keyboard
    /// navigation moves over.
    pub fn report_ids(&self) -> Vec<&str> {
        self.providers.iter().map(|r| r.provider_id.as_str()).collect()
    }

    /// Replace the report set, clamping `selected` to a valid index.
    pub fn set_reports(&mut self, reports: Vec<UsageReport>) {
        self.reports = reports;
        self.providers = group_reports(&self.reports);
        let n = self.providers.len();
        if n == 0 {
            self.selected = 0;
        } else if self.selected >= n {
            self.selected = n - 1;
        }
    }

    /// `(provider, usedFraction)` pairs from each report's primary limit. Used
    /// to render the holistic capacity bar chart.
    pub fn primary_used_fractions(&self) -> Vec<(&str, f64)> {
        self.providers
            .iter()
            .filter_map(|section| {
                section
                    .reports
                    .iter()
                    .flat_map(|r| r.limits.iter())
                    .filter_map(|l| l.amount.used_fraction)
                    .max_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
                    .map(|f| (section.provider_id.as_str(), f))
            })
            .collect()
    }

    /// Rebuild the token series from the local SQLite store. Window is the
    /// last `TOKEN_BUCKETS` hours ending at the current clock hour.
    pub fn refresh_tokens(&mut self) {
        let now_ms = chrono::Utc::now().timestamp_millis();
        let hour = now_ms / TOKEN_BUCKET_MS;
        let start = (hour - (TOKEN_BUCKETS as i64 - 1)) * TOKEN_BUCKET_MS;
        self.token_start_ms = start;
        let provs = self
            .db
            .hourly_by_provider(start, TOKEN_BUCKET_MS, TOKEN_BUCKETS)
            .unwrap_or_default();
        let mut total = vec![0u64; TOKEN_BUCKETS];
        for p in &provs {
            for (i, v) in p.buckets.iter().enumerate() {
                if i < total.len() {
                    total[i] += *v;
                }
            }
        }
        self.token_providers = provs;
        self.token_total = total;
        if self.token_providers.is_empty() {
            self.token_selected = 0;
        } else if self.token_selected >= self.token_providers.len() {
            self.token_selected = self.token_providers.len() - 1;
        }
    }

    /// `false` to quit the loop.
    pub fn handle_key(&mut self, k: super::events::Key) -> bool {
        use super::events::Key;
        let n = self.providers.len();
        let tn = self.token_providers.len();
        match k {
            Key::Quit => return false,
            Key::SyncNow => self.syncing = true,
            Key::Help => self.show_help = !self.show_help,
            Key::Tab => {
                self.mode = match self.mode {
                    Mode::Holistic | Mode::Provider(_) => Mode::Tokens,
                    Mode::Tokens | Mode::TokenProvider(_) => Mode::Holistic,
                };
            }
            Key::Up => match self.mode {
                Mode::Holistic if n > 0 => {
                    self.selected = if self.selected == 0 { n - 1 } else { self.selected - 1 };
                }
                Mode::Provider(i) if n > 0 => {
                    self.mode = Mode::Provider(if i == 0 { n - 1 } else { i - 1 });
                }
                Mode::Tokens if tn > 0 => {
                    self.token_selected = if self.token_selected == 0 {
                        tn - 1
                    } else {
                        self.token_selected - 1
                    };
                }
                Mode::TokenProvider(i) if tn > 0 => {
                    self.mode = Mode::TokenProvider(if i == 0 { tn - 1 } else { i - 1 });
                }
                _ => {}
            },
            Key::Down => match self.mode {
                Mode::Holistic if n > 0 => self.selected = (self.selected + 1) % n,
                Mode::Provider(i) if n > 0 => self.mode = Mode::Provider((i + 1) % n),
                Mode::Tokens if tn > 0 => self.token_selected = (self.token_selected + 1) % tn,
                Mode::TokenProvider(i) if tn > 0 => self.mode = Mode::TokenProvider((i + 1) % tn),
                _ => {}
            },
            Key::Enter => match self.mode {
                Mode::Holistic if n > 0 => self.mode = Mode::Provider(self.selected),
                Mode::Tokens if tn > 0 => self.mode = Mode::TokenProvider(self.token_selected),
                _ => {}
            },
            Key::Back => match self.mode {
                Mode::Provider(_) => self.mode = Mode::Holistic,
                Mode::TokenProvider(_) => self.mode = Mode::Tokens,
                Mode::Tokens => self.mode = Mode::Holistic,
                Mode::Holistic => return false,
            },
        }
        true
    }

    /// Provider currently in focus (drill-in target or selected row in holistic).
    pub fn current_report(&self) -> Option<&UsageReport> {
        self.current_provider().and_then(|p| p.reports.first())
    }

    pub fn current_provider(&self) -> Option<&ProviderSection> {
        let pos = match self.mode {
            Mode::Provider(i) => i,
            Mode::Holistic => self.selected,
            Mode::Tokens | Mode::TokenProvider(_) => return None,
        };
        self.providers.get(pos)
    }
}

fn group_reports(reports: &[UsageReport]) -> Vec<ProviderSection> {
    use std::collections::BTreeMap;

    let mut grouped: BTreeMap<String, Vec<UsageReport>> = BTreeMap::new();
    for report in reports {
        grouped.entry(report.provider.clone()).or_default().push(report.clone());
    }
    grouped
        .into_iter()
        .map(|(provider_id, mut reports)| {
            reports.sort_by(|a, b| a.account.cmp(&b.account));
            let fetched_at = reports.iter().map(|r| r.fetched_at).max().unwrap_or(0);
            let provider_label = crate::registry::by_id(&provider_id)
                .map(|p| p.label.to_string())
                .unwrap_or_else(|| provider_id.clone());
            ProviderSection { provider_id, provider_label, reports, fetched_at }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::db::Db;
    use crate::usage::{UsageAmount, UsageLimit, UsageScope, UsageUnit};

    fn make_report(provider: &str, used_pct: f64) -> UsageReport {
        UsageReport {
            provider: provider.into(),
            account: "test".into(),
            fetched_at: 0,
            limits: vec![UsageLimit {
                id: "test:primary".into(),
                label: "primary".into(),
                tier: None,
                scope: UsageScope {
                    provider: provider.into(),
                    account_id: Some("test".into()),
                    project_id: None,
                    org_id: None,
                    model_id: None,
                    tier: None,
                    window_id: None,
                    shared: true,
                },
                window: None,
                amount: UsageAmount {
                    used: Some(used_pct),
                    limit: Some(100.0),
                    used_fraction: Some(used_pct / 100.0),
                    unit: UsageUnit::Percent,
                    ..Default::default()
                },
                status: crate::usage::UsageStatus::Ok,
                notes: Vec::new(),
            }],
            notes: Vec::new(),
        }
    }

    fn app_with_reports(providers: &[&str]) -> App {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("atop.db")).unwrap();
        let mut app = App::new(Arc::new(db), Arc::new(Config::default()));
        app.set_reports(providers.iter().map(|p| make_report(p, 50.0)).collect());
        app
    }

    #[test]
    fn enter_and_back_navigate() {
        use super::super::events::Key;
        let mut app = app_with_reports(&["zai", "anthropic"]);
        app.mode = Mode::Holistic;
        assert_eq!(app.mode, Mode::Holistic);
        assert!(app.handle_key(Key::Enter));
        assert!(matches!(app.mode, Mode::Provider(_)));
        assert!(app.handle_key(Key::Back));
        assert_eq!(app.mode, Mode::Holistic);
        assert!(!app.handle_key(Key::Back), "back from holistic quits");
    }

    #[test]
    fn down_wraps_in_holistic() {
        use super::super::events::Key;
        let mut app = app_with_reports(&["zai", "anthropic"]);
        app.mode = Mode::Holistic;
        app.handle_key(Key::Down);
        assert_eq!(app.selected, 1);
        app.handle_key(Key::Down);
        assert_eq!(app.selected, 0, "wraps to first");
    }

    #[test]
    fn token_navigation() {
        use super::super::events::Key;
        let mut app = app_with_reports(&["zai"]);
        app.token_providers = vec![
            crate::db::ProviderHourly {
                provider: "anthropic".into(),
                buckets: vec![0; TOKEN_BUCKETS],
                total_tokens: 100,
                est_cost: 0.05,
            },
            crate::db::ProviderHourly {
                provider: "openai".into(),
                buckets: vec![0; TOKEN_BUCKETS],
                total_tokens: 50,
                est_cost: 0.02,
            },
        ];
        app.token_selected = 0;
        app.mode = Mode::Tokens;
        assert_eq!(app.mode, Mode::Tokens);
        app.handle_key(Key::Tab);
        assert_eq!(app.mode, Mode::Holistic);
        app.handle_key(Key::Tab);
        assert_eq!(app.mode, Mode::Tokens);
        app.handle_key(Key::Down);
        assert_eq!(app.token_selected, 1);
        app.handle_key(Key::Down);
        assert_eq!(app.token_selected, 0, "wraps to first");
        app.handle_key(Key::Enter);
        assert!(matches!(app.mode, Mode::TokenProvider(0)));
        app.handle_key(Key::Back);
        assert_eq!(app.mode, Mode::Tokens);
    }

    #[test]
    fn primary_fractions_skip_unreported() {
        let mut app = app_with_reports(&["zai"]);
        app.reports.push(UsageReport {
            provider: "no-fraction".into(),
            account: "x".into(),
            fetched_at: 0,
            limits: vec![],
            notes: Vec::new(),
        });
        app.providers = group_reports(&app.reports);
        let f = app.primary_used_fractions();
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].0, "zai");
        assert!((f[0].1 - 0.5).abs() < 1e-9);
    }

    #[test]
    fn groups_multiple_accounts_under_one_provider() {
        let mut app = app_with_reports(&["anthropic", "anthropic", "zai"]);
        app.reports[0].account = "a@x.com".into();
        app.reports[1].account = "b@x.com".into();
        app.set_reports(app.reports.clone());
        assert_eq!(app.providers.len(), 2);
        let anthropic = app.providers.iter().find(|p| p.provider_id == "anthropic").unwrap();
        assert_eq!(anthropic.account_count(), 2);
    }
}
