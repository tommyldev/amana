use anyhow::Result;
use async_trait::async_trait;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::config::ProviderCfg;
use crate::db::Db;

use super::{FetchOutcome, Source};

mod parse;

#[cfg(test)]
mod tests;

pub struct ClaudeCodeSource {
    pub root: PathBuf,
}

impl Default for ClaudeCodeSource {
    fn default() -> Self {
        let root = std::env::var_os("ATOP_CLAUDE_DIR")
            .map(PathBuf::from)
            .or_else(|| {
                directories::UserDirs::new().map(|u| u.home_dir().join(".claude").join("projects"))
            })
            .unwrap_or_else(|| PathBuf::from("~/.claude/projects"));
        Self { root }
    }
}

#[async_trait]
impl Source for ClaudeCodeSource {
    fn id(&self) -> &str { "claude-code" }

    async fn fetch(&self, db: &Db, _cfg: &ProviderCfg) -> Result<FetchOutcome> {
        if !self.root.exists() {
            return Ok(FetchOutcome { inserted: 0, status: "no data".into() });
        }
        let mut total = 0usize;
        let mut files = Vec::new();
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
            } else if p.extension().and_then(|x| x.to_str()) == Some("jsonl") {
                out.push(p);
            }
        }
    }
}

async fn process_file(db: &Db, path: &Path) -> Result<usize> {
    let meta = tokio::fs::metadata(path).await?;
    let mtime_ms = meta.modified().ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let path_str = path.to_string_lossy().to_string();
    let sync = db.get_sync("claude-code", &path_str)?;
    let (mut offset, _) = match sync {
        Some(s) if s.1 == mtime_ms => return Ok(0),
        Some(s) => (s.0, Some(s.1)),
        None => (0, None),
    };
    if (meta.len() as i64) < offset { offset = 0; }
    let mut file = tokio::fs::File::open(path).await?;
    use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};
    file.seek(SeekFrom::Start(offset as u64)).await?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).await?;
    let new_offset = offset + buf.len() as i64;
    if buf.is_empty() {
        db.set_sync("claude-code", &path_str, new_offset, mtime_ms)?;
        return Ok(0);
    }
    let mut rows = Vec::new();
    for line in buf.split(|b| *b == b'\n') {
        if line.is_empty() { continue; }
        if let Some(r) = parse::parse_line(line) {
            rows.push(r);
        }
    }
    let inserted = db.insert_events_dedup_completion(rows)?;
    db.set_sync("claude-code", &path_str, new_offset, mtime_ms)?;
    Ok(inserted)
}
