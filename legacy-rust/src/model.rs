use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageEventRow {
    pub source: String,
    pub source_message_id: String,
    pub timestamp_ms: i64,
    pub provider: String,
    pub model: String,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub total_tokens: i64,
    pub cost_usd: Option<f64>,
    pub cost_origin: String,
}

#[derive(Debug, Clone, Default)]
pub struct UsageAggregate {
    pub requests: i64,
    pub prompt: i64,
    pub completion: i64,
    pub total: i64,
    pub cost: f64,
}

#[derive(Debug, Clone)]
pub struct ModelBreakdown {
    pub model: String,
    pub requests: i64,
    pub total_tokens: i64,
    pub cost: f64,
}