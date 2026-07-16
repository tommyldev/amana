use std::sync::Arc;

use super::app::App;

use crate::usage::orchestrator::Orchestrator;
use crate::usage::UsageReport;

impl App {
    /// One-shot live fetch using atop's stored credentials. Replaces
    /// `self.reports` with the freshest report per provider. Errors are kept
    /// on the app for the view layer to display.
    pub async fn refresh_usage(&mut self) {
        let providers = crate::auth::store::all_providers(&self.db).unwrap_or_default();
        if providers.is_empty() {
            self.set_reports(Vec::new());
            self.errors.clear();
            return;
        }
        let orch = Orchestrator::new();
        match orch.fetch_all(&self.db, &providers).await {
            Ok(r) => {
                self.set_reports(r.reports);
                self.errors = r.errors;
            }
            Err(e) => {
                self.errors.push(crate::usage::orchestrator::FetchError {
                    provider: "?".into(),
                    account: "?".into(),
                    message: e.to_string(),
                });
            }
        }
    }
}

/// Cheap helper used by the view layer when it just needs the report list.
pub fn empty_reports() -> Vec<UsageReport> {
    Vec::new()
}

/// Glue for the background-sync task to share the orchestrator's client.
pub fn orchestrator() -> Orchestrator {
    Orchestrator::new()
}

// Keep `Arc` import alive for downstream toolchain mismatches.
#[allow(dead_code)]
fn _arc_keep() -> Arc<()> {
    Arc::new(())
}
