use anyhow::Result;
use std::collections::HashMap;

use crate::config::Config;
use crate::db::Db;
use crate::registry;
use crate::source::{
    AdminAnthropicSource, AdminOpenAISource, ClaudeCodeSource, OmpSource, Source,
};

pub async fn run_sync(
    db: &Db,
    cfg: &Config,
    full: bool,
) -> Result<HashMap<String, usize>> {
    let mut counts: HashMap<String, usize> = HashMap::new();

    // Phase 1: ingest raw sources. Each source is synced at most once,
    // regardless of how many providers read from it. An omp-log provider
    // with `omp_provider == None` is the "raw" entry that triggers the
    // actual directory scan; providers with `omp_provider == Some(_)`
    // are filtered views into already-ingested data and skip ingestion.
    let mut omp_done = false;
    let mut cc_done = false;
    for prov in &cfg.providers {
        if !prov.enabled {
            continue;
        }
        let Some(def) = registry::by_id(&prov.id) else {
            db.set_provider_status(&prov.id, "unknown")?;
            continue;
        };

        let should_sync = match def.source_kind {
            registry::SourceKind::LogOmp => {
                // Only the raw "omp" entry (omp_provider == None) triggers
                // the directory scan. Per-provider entries read from the
                // already-ingested rows.
                if def.omp_provider.is_none() && !omp_done {
                    omp_done = true;
                    true
                } else {
                    false
                }
            }
            registry::SourceKind::LogClaudeCode => {
                if !cc_done {
                    cc_done = true;
                    true
                } else {
                    false
                }
            }
            registry::SourceKind::AdminOpenAI | registry::SourceKind::AdminAnthropic => true,
        };

        if should_sync {
            let outcome = dispatch(db, prov, def.source_kind, full).await;
            match outcome {
                Ok(o) => {
                    counts.insert(prov.id.clone(), o.inserted);
                    if !o.status.is_empty() {
                        let _ = db.set_provider_status(&prov.id, &o.status);
                    }
                }
                Err(e) => {
                    let msg = format!("error: {e}");
                    let _ = db.set_provider_status(&prov.id, &msg);
                    counts.insert(prov.id.clone(), 0);
                }
            }
        }
    }
    Ok(counts)
}

async fn dispatch(
    db: &Db,
    prov: &crate::config::ProviderCfg,
    kind: registry::SourceKind,
    full: bool,
) -> Result<crate::source::FetchOutcome> {
    use registry::SourceKind;
    // `full` re-reads from byte 0 by resetting the sync_state offset.
    if full {
        reset_source_sync_state(db, kind);
    }
    match kind {
        SourceKind::LogOmp => OmpSource::default().fetch(db, prov).await,
        SourceKind::LogClaudeCode => ClaudeCodeSource::default().fetch(db, prov).await,
        SourceKind::AdminOpenAI => AdminOpenAISource.fetch(db, prov).await,
        SourceKind::AdminAnthropic => AdminAnthropicSource.fetch(db, prov).await,
    }
}

/// Reset the incremental sync offsets for a source so the next fetch
/// re-reads from byte 0. This is a best-effort operation — if the
/// sync_state table doesn't have matching rows, nothing happens.
fn reset_source_sync_state(db: &Db, kind: registry::SourceKind) {
    let source = match kind {
        registry::SourceKind::LogOmp => "omp",
        registry::SourceKind::LogClaudeCode => "claude-code",
        registry::SourceKind::AdminOpenAI => "openai-api",
        registry::SourceKind::AdminAnthropic => "anthropic-api",
    };
    let conn = db.conn.lock();
    let _ = conn.execute("DELETE FROM sync_state WHERE source = ?", [source]);
}