use anyhow::Result;
use rusqlite::params;

use crate::model::{UsageAggregate, UsageEventRow};

pub fn insert_events(db: &super::Db, rows: Vec<UsageEventRow>) -> Result<usize> {
    let conn = db.conn.lock();
    let mut stmt = conn.prepare_cached(
        "INSERT OR IGNORE INTO usage_events
         (source, source_message_id, timestamp_ms, provider, model,
          prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens,
          total_tokens, cost_usd, cost_origin)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    )?;
    let mut inserted = 0;
    for r in &rows {
        let n = stmt.execute(params![
            r.source, r.source_message_id, r.timestamp_ms, r.provider, r.model,
            r.prompt_tokens, r.completion_tokens, r.cache_read_tokens, r.cache_write_tokens,
            r.total_tokens, r.cost_usd, r.cost_origin,
        ])?;
        inserted += n;
    }
    Ok(inserted)
}

pub fn insert_events_dedup_completion(db: &super::Db, rows: Vec<UsageEventRow>) -> Result<usize> {
    let conn = db.conn.lock();
    let mut stmt = conn.prepare_cached(
        "INSERT INTO usage_events
         (source, source_message_id, timestamp_ms, provider, model,
          prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens,
          total_tokens, cost_usd, cost_origin)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(source, source_message_id) DO UPDATE SET
           completion_tokens = MAX(usage_events.completion_tokens, excluded.completion_tokens),
           prompt_tokens = MAX(usage_events.prompt_tokens, excluded.prompt_tokens),
           cache_read_tokens = MAX(usage_events.cache_read_tokens, excluded.cache_read_tokens),
           cache_write_tokens = MAX(usage_events.cache_write_tokens, excluded.cache_write_tokens),
           total_tokens = MAX(usage_events.total_tokens, excluded.total_tokens),
           cost_usd = CASE
               WHEN excluded.cost_origin = 'api' THEN excluded.cost_usd
               WHEN usage_events.cost_origin = 'api' THEN usage_events.cost_usd
               ELSE COALESCE(excluded.cost_usd, usage_events.cost_usd)
           END,
           cost_origin = CASE
               WHEN excluded.cost_origin = 'api' THEN 'api'
               WHEN usage_events.cost_origin = 'api' THEN 'api'
               ELSE excluded.cost_origin
           END",
    )?;
    let mut updated = 0;
    for r in &rows {
        let n = stmt.execute(params![
            r.source, r.source_message_id, r.timestamp_ms, r.provider, r.model,
            r.prompt_tokens, r.completion_tokens, r.cache_read_tokens, r.cache_write_tokens,
            r.total_tokens, r.cost_usd, r.cost_origin,
        ])?;
        updated += n;
    }
    Ok(updated)
}

pub fn upsert_admin(db: &super::Db, rows: Vec<UsageEventRow>) -> Result<usize> {
    let conn = db.conn.lock();
    let mut stmt = conn.prepare_cached(
        "INSERT INTO usage_events
         (source, source_message_id, timestamp_ms, provider, model,
          prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens,
          total_tokens, cost_usd, cost_origin)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(source, source_message_id) DO UPDATE SET
           prompt_tokens = excluded.prompt_tokens,
           completion_tokens = excluded.completion_tokens,
           total_tokens = excluded.total_tokens,
           cost_usd = excluded.cost_usd,
           cost_origin = 'api'",
    )?;
    let mut updated = 0;
    for r in &rows {
        let n = stmt.execute(params![
            r.source, r.source_message_id, r.timestamp_ms, r.provider, r.model,
            r.prompt_tokens, r.completion_tokens, r.cache_read_tokens, r.cache_write_tokens,
            r.total_tokens, r.cost_usd, r.cost_origin,
        ])?;
        updated += n;
    }
    Ok(updated)
}

pub fn window_usage(
    db: &super::Db,
    start_ms: i64,
    next_reset_ms: i64,
    sources: &[String],
    provider: Option<&str>,
) -> Result<UsageAggregate> {
    if sources.is_empty() {
        return Ok(UsageAggregate::default());
    }
    let placeholders = std::iter::repeat_n("?", sources.len()).collect::<Vec<_>>().join(",");
    let prov_clause = provider.map(|_| " AND provider = ?").unwrap_or("");
    let sql = format!(
        "SELECT
           COUNT(*),
           COALESCE(SUM(prompt_tokens), 0),
           COALESCE(SUM(completion_tokens), 0),
           COALESCE(SUM(total_tokens), 0),
           COALESCE(SUM(cost_usd), 0.0)
         FROM usage_events
         WHERE timestamp_ms >= ? AND timestamp_ms < ?
           AND source IN ({placeholders}){prov_clause}"
    );
    let conn = db.conn.lock();
    let mut params: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(2 + sources.len() + 1);
    params.push(&start_ms);
    params.push(&next_reset_ms);
    for s in sources { params.push(s); }
    if provider.is_some() { params.push(&provider); }
    let agg = conn.query_row(&sql, rusqlite::params_from_iter(params), |r| {
        Ok(UsageAggregate {
            requests: r.get(0)?,
            prompt: r.get(1)?,
            completion: r.get(2)?,
            total: r.get(3)?,
            cost: r.get(4)?,
        })
    })?;
    Ok(agg)
}

pub fn todays_totals(db: &super::Db, now_ms: i64) -> Result<UsageAggregate> {
    let start = now_ms - (now_ms % 86_400_000);
    let next = start + 86_400_000;
    let conn = db.conn.lock();
    let agg = conn.query_row(
        "SELECT
           COUNT(*),
           COALESCE(SUM(prompt_tokens), 0),
           COALESCE(SUM(completion_tokens), 0),
           COALESCE(SUM(total_tokens), 0),
           COALESCE(SUM(cost_usd), 0.0)
         FROM usage_events
         WHERE timestamp_ms >= ? AND timestamp_ms < ?",
        params![start, next],
        |r| Ok(UsageAggregate {
            requests: r.get(0)?,
            prompt: r.get(1)?,
            completion: r.get(2)?,
            total: r.get(3)?,
            cost: r.get(4)?,
        }),
    )?;
    Ok(agg)
}
