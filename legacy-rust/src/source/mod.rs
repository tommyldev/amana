use anyhow::Result;
use async_trait::async_trait;

use crate::config::ProviderCfg;
use crate::db::Db;

pub mod omp;
pub mod claude_code;
pub mod admin_openai;
pub mod admin_anthropic;

pub use omp::OmpSource;
pub use claude_code::ClaudeCodeSource;
pub use admin_openai::AdminOpenAISource;
pub use admin_anthropic::AdminAnthropicSource;

#[async_trait]
pub trait Source: Send + Sync {
    fn id(&self) -> &str;
    async fn fetch(&self, db: &Db, cfg: &ProviderCfg) -> Result<FetchOutcome>;
}

#[derive(Debug, Default, Clone)]
pub struct FetchOutcome {
    pub inserted: usize,
    /// "no_admin_key", "no data", "ok", or an "error: <msg>" string.
    pub status: String,
}
