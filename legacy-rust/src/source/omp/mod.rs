use anyhow::{Context, Result};
use async_trait::async_trait;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::config::ProviderCfg;
use crate::db::Db;
use super::{FetchOutcome, Source};

mod parse;

#[cfg(test)]
mod tests;

pub struct OmpSource {
    pub root: PathBuf,
}

impl Default for OmpSource {
    fn default() -> Self {
        let root = std::env::var_os("ATOP_OMP_DIR").map(PathBuf::from);
        let root = root.unwrap_or_else(|| {
            let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
            home.join(".omp/agent/sessions")
        });
        Self { root }
    }
}

#[async_trait]
impl Source for OmpSource {
    fn id(&self) -> &str { "omp" }

    async fn fetch(&self, db: &Db, _cfg: &ProviderCfg) -> Result<FetchOutcome> {
        if !self.root.exists() {
            return Ok(FetchOutcome { inserted: 0, status: "no data".into() });
        }
        let mut total = 0usize;
        let mut files: Vec<PathBuf> = Vec::new();
        collect_jsonl(&self.root, &mut files);
        for path in files {
            total += process_file(db, &path).await?;
        }
        Ok(FetchOutcome { inserted: total, status: "ok".into() })
    }
}

fn collect_jsonl(root: &Path, out: &mut Vec<PathBuf>) {
    if let Ok(rd) = std::fs::read_dir(root) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                collect_jsonl(&p, out);
            } else if p.extension().and_then(|x| x.to_str()).is_some_and(|x| x == "jsonl") {
                out.push(p);
            }
        }
    }
}

async fn process_file(db: &Db, path: &Path) -> Result<usize> {
    let meta = tokio::fs::metadata(path).await
        .with_context(|| format!("stat {}", path.display()))?;
    let mtime_ms = meta.modified().ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let path_str = path.to_string_lossy().to_string();
    let sync = db.get_sync("omp", &path_str)?;
    let (mut offset, _) = match sync {
        Some(s) => s,
        None => (0, 0),
    };
    if (meta.len() as i64) < offset { offset = 0; }
    let mut file = tokio::fs::File::open(path).await?;
    use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};
    file.seek(SeekFrom::Start(offset as u64)).await?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).await?;
    let new_offset = offset + buf.len() as i64;
    if buf.is_empty() {
        return Ok(0);
    }
    let mut rows = Vec::new();
    for line in buf.split(|b| *b == b'\n') {
        if line.is_empty() { continue; }
        if let Some(row) = parse::parse_line(line) {
            rows.push(row);
        }
    }
    let inserted = db.insert_events(rows)?;
    db.set_sync("omp", &path_str, new_offset, mtime_ms)?;
    Ok(inserted)
}

#[allow(dead_code)]
fn _now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}