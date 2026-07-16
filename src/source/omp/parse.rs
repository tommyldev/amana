use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;

use crate::model::UsageEventRow;

pub fn parse_line(line: &[u8]) -> Option<UsageEventRow> {
    let entry: OmpEntry = serde_json::from_slice(line).ok()?;
    if entry.ty.as_deref() != Some("message") { return None; }
    let msg = entry.message?;
    if msg.role.as_deref() != Some("assistant") { return None; }
    let id = entry.id?;
    let usage = msg.usage?;
    let prompt = usage.input.unwrap_or(0) as i64;
    let completion = usage.output.unwrap_or(0) as i64;
    let cache_read = usage.cache_read.unwrap_or(0) as i64;
    let cache_write = usage.cache_write.unwrap_or(0) as i64;
    let total = prompt + completion + cache_read + cache_write;
    let cost = usage.cost.and_then(|c| c.total);
    let provider = msg.provider.unwrap_or_else(|| "unknown".into());
    let model = msg.model.unwrap_or_else(|| "unknown".into());
    let ts = msg.timestamp.as_ref().map(timestamp_to_ms).unwrap_or_else(now_ms);
    Some(UsageEventRow {
        source: "omp".into(),
        source_message_id: id,
        timestamp_ms: ts,
        provider,
        model,
        prompt_tokens: prompt,
        completion_tokens: completion,
        cache_read_tokens: cache_read,
        cache_write_tokens: cache_write,
        total_tokens: total,
        cost_usd: cost,
        cost_origin: "logged".into(),
    })
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Accept a timestamp as either an integer (epoch millis) or a string
/// (epoch millis as digits, or an RFC 3339 date-time).
fn timestamp_to_ms(ts: &TimestampValue) -> i64 {
    match ts {
        TimestampValue::Int(n) => *n,
        TimestampValue::Str(s) => {
            if let Ok(n) = s.parse::<i64>() { return n; }
            if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
                return dt.timestamp_millis();
            }
            0
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum TimestampValue {
    Int(i64),
    Str(String),
}

#[derive(Debug, Deserialize)]
pub struct OmpEntry {
    #[serde(rename = "type")]
    pub ty: Option<String>,
    pub id: Option<String>,
    #[serde(default)]
    pub message: Option<OmpMsg>,
}

#[derive(Debug, Deserialize, Default)]
pub struct OmpMsg {
    pub role: Option<String>,
    pub model: Option<String>,
    pub provider: Option<String>,
    pub usage: Option<OmpUsage>,
    pub timestamp: Option<TimestampValue>,
}

#[derive(Debug, Deserialize, Default)]
pub struct OmpUsage {
    pub input: Option<u64>,
    pub output: Option<u64>,
    #[serde(rename = "cacheRead", alias = "cache_read", default)]
    pub cache_read: Option<u64>,
    #[serde(rename = "cacheWrite", alias = "cache_write", default)]
    pub cache_write: Option<u64>,
    #[serde(default)]
    pub cost: Option<OmpCost>,
}

#[derive(Debug, Deserialize, Default)]
pub struct OmpCost {
    pub total: Option<f64>,
}