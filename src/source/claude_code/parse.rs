use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;

use crate::model::UsageEventRow;
use crate::price;

pub fn parse_line(line: &[u8]) -> Option<UsageEventRow> {
    let entry: CcEntry = serde_json::from_slice(line).ok()?;
    if entry.r#type.as_deref() != Some("assistant") { return None; }
    let msg = entry.message?;
    if msg.role.as_deref() != Some("assistant") { return None; }
    let usage = msg.usage?;
    let uuid = entry.uuid?;
    let model = msg.model.unwrap_or_else(|| "unknown".into());
    let prompt = usage.input_tokens.unwrap_or(0) as i64;
    let completion = usage.output_tokens.unwrap_or(0) as i64;
    let cache_read = usage.cache_read_input_tokens.unwrap_or(0) as i64;
    let cache_write = usage.cache_creation_input_tokens.unwrap_or(0) as i64;
    let total = prompt + completion + cache_read + cache_write;
    let cost = price::cost(&model, prompt.max(0) as u64, completion.max(0) as u64);
    let provider = infer_provider(&model);
    let ts = entry.timestamp.as_deref()
        .and_then(parse_timestamp)
        .unwrap_or_else(now_ms);
    Some(UsageEventRow {
        source: "claude-code".into(),
        source_message_id: uuid,
        timestamp_ms: ts,
        provider,
        model,
        prompt_tokens: prompt,
        completion_tokens: completion,
        cache_read_tokens: cache_read,
        cache_write_tokens: cache_write,
        total_tokens: total,
        cost_usd: cost,
        cost_origin: "computed".into(),
    })
}

fn infer_provider(model: &str) -> String {
    if model.starts_with("claude") { "anthropic".into() } else { "unknown".into() }
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn parse_timestamp(s: &str) -> Option<i64> {
    if let Ok(n) = s.parse::<i64>() { return Some(n); }
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(dt.timestamp_millis());
    }
    None
}

#[derive(Debug, Deserialize)]
pub struct CcEntry {
    #[serde(rename = "type")]
    pub r#type: Option<String>,
    pub uuid: Option<String>,
    pub timestamp: Option<String>,
    #[serde(default)]
    pub message: Option<CcMsg>,
}

#[derive(Debug, Deserialize, Default)]
pub struct CcMsg {
    pub role: Option<String>,
    pub model: Option<String>,
    #[serde(default)]
    pub usage: Option<CcUsage>,
}

#[derive(Debug, Deserialize, Default)]
pub struct CcUsage {
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cache_read_input_tokens: Option<i64>,
    pub cache_creation_input_tokens: Option<i64>,
}
