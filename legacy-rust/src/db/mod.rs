use anyhow::{Context, Result};
use parking_lot::Mutex;
use rusqlite::{params, Connection};
use std::path::{Path, PathBuf};

use crate::model::{ModelBreakdown, UsageAggregate, UsageEventRow};

mod breakdown;
mod secrets;
mod providers;
mod series;
pub use series::ProviderHourly;
mod sync_state;
mod usage;

#[cfg(test)]
mod tests;

pub struct Db {
    pub(crate) conn: Mutex<Connection>,
    pub path: PathBuf,
}

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let conn = Connection::open(path).with_context(|| format!("open {}", path.display()))?;
        conn.pragma_update(None, "journal_mode", "WAL").ok();
        conn.pragma_update(None, "foreign_keys", "ON").ok();
        let db = Self { conn: Mutex::new(conn), path: path.to_path_buf() };
        db.migrate()?;
        Ok(db)
    }

    pub fn migrate(&self) -> Result<()> {
        self.conn.lock().execute_batch(SCHEMA).context("migrate")?;
        Ok(())
    }

    pub fn insert_events(&self, rows: Vec<UsageEventRow>) -> Result<usize> {
        usage::insert_events(self, rows)
    }

    pub fn insert_events_dedup_completion(&self, rows: Vec<UsageEventRow>) -> Result<usize> {
        usage::insert_events_dedup_completion(self, rows)
    }

    pub fn upsert_admin(&self, rows: Vec<UsageEventRow>) -> Result<usize> {
        usage::upsert_admin(self, rows)
    }

    pub fn window_usage(
        &self,
        start_ms: i64,
        next_reset_ms: i64,
        sources: &[String],
        provider: Option<&str>,
    ) -> Result<UsageAggregate> {
        usage::window_usage(self, start_ms, next_reset_ms, sources, provider)
    }

    pub fn todays_totals(&self, now_ms: i64) -> Result<UsageAggregate> {
        usage::todays_totals(self, now_ms)
    }

    pub fn window_series(
        &self,
        start_ms: i64,
        next_reset_ms: i64,
        sources: &[String],
        provider: Option<&str>,
        buckets: usize,
    ) -> Result<Vec<u64>> {
        series::window_series(self, start_ms, next_reset_ms, sources, provider, buckets)
    }

    pub fn hourly_by_provider(
        &self,
        start_ms: i64,
        bucket_ms: i64,
        buckets: usize,
    ) -> Result<Vec<series::ProviderHourly>> {
        series::hourly_by_provider(self, start_ms, bucket_ms, buckets)
    }

    pub fn breakdown_by_model(
        &self,
        start_ms: i64,
        next_reset_ms: i64,
        sources: &[String],
        provider: Option<&str>,
    ) -> Result<Vec<ModelBreakdown>> {
        breakdown::breakdown_by_model(self, start_ms, next_reset_ms, sources, provider)
    }

    pub fn recent_events(
        &self,
        sources: &[String],
        provider: Option<&str>,
        limit: u64,
    ) -> Result<Vec<UsageEventRow>> {
        breakdown::recent_events(self, sources, provider, limit)
    }

    pub fn set_sync(&self, source: &str, path: &str, offset: i64, mtime_ms: i64) -> Result<()> {
        sync_state::set_sync(self, source, path, offset, mtime_ms)
    }

    pub fn get_sync(&self, source: &str, path: &str) -> Result<Option<(i64, i64)>> {
        sync_state::get_sync(self, source, path)
    }

    pub fn set_provider_status(&self, id: &str, status: &str) -> Result<()> {
        providers::set_provider_status(self, id, status)
    }

    pub fn ensure_provider(&self, id: &str, label: &str, source_kind: &str) -> Result<()> {
        providers::ensure_provider(self, id, label, source_kind)
    }

    pub fn provider_status(&self, id: &str) -> Result<Option<String>> {
        providers::provider_status(self, id)
    }

    /// Test seam.
    pub fn count_source(&self, source: &str) -> Result<i64> {
        let n: i64 = self.conn.lock().query_row(
            "SELECT COUNT(*) FROM usage_events WHERE source = ?",
            params![source],
            |r| r.get(0),
        )?;
        Ok(n)
    }

    pub fn get_secret(&self, id: &str) -> Result<Option<String>> {
        secrets::get(self, id)
    }

    pub fn set_secret(&self, id: &str, value: &str) -> Result<()> {
        secrets::set(self, id, value)
    }

    pub fn delete_secret(&self, id: &str) -> Result<()> {
        secrets::delete(self, id)
    }

    /// All secret ids currently in the store. Used by `atop auth logout` and
    /// tests; not part of the hot path.
    pub fn secret_ids(&self) -> Result<Vec<String>> {
        secrets::list_ids(self)
    }
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS usage_events(
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  timestamp_ms INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL,
  cost_usd REAL,
  cost_origin TEXT NOT NULL,
  UNIQUE(source, source_message_id) ON CONFLICT IGNORE);
CREATE TABLE IF NOT EXISTS providers(
  id TEXT PRIMARY KEY, label TEXT NOT NULL, source_kind TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'ok');
CREATE TABLE IF NOT EXISTS sync_state(
  source TEXT NOT NULL, path TEXT NOT NULL, offset INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL, PRIMARY KEY(source,path));
CREATE TABLE IF NOT EXISTS secrets(
  id TEXT PRIMARY KEY,
  nonce BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  updated_at_ms INTEGER NOT NULL);
"#;