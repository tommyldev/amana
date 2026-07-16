use anyhow::Result;

use crate::model::{ModelBreakdown, UsageEventRow};

pub fn breakdown_by_model(
    db: &super::Db,
    start_ms: i64,
    next_reset_ms: i64,
    sources: &[String],
    provider: Option<&str>,
) -> Result<Vec<ModelBreakdown>> {
    if sources.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = std::iter::repeat_n("?", sources.len())
        .collect::<Vec<_>>()
        .join(",");
    let prov_clause = provider.map(|_| " AND provider = ?").unwrap_or("");
    let sql = format!(
        "SELECT model, COUNT(*), COALESCE(SUM(total_tokens),0), COALESCE(SUM(cost_usd),0.0)
         FROM usage_events
         WHERE timestamp_ms >= ? AND timestamp_ms < ?
           AND source IN ({placeholders}){prov_clause}
         GROUP BY model
         ORDER BY SUM(total_tokens) DESC"
    );
    let conn = db.conn.lock();
    let mut stmt = conn.prepare(&sql)?;
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::with_capacity(2 + sources.len() + 1);
    params.push(Box::new(start_ms));
    params.push(Box::new(next_reset_ms));
    for s in sources {
        params.push(Box::new(s.clone()));
    }
    if let Some(p) = provider {
        params.push(Box::new(p));
    }
    let refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|b| b.as_ref() as &dyn rusqlite::ToSql).collect();
    let rows = stmt.query_map(rusqlite::params_from_iter(refs), |r| {
        Ok(ModelBreakdown {
            model: r.get(0)?,
            requests: r.get(1)?,
            total_tokens: r.get(2)?,
            cost: r.get::<_, f64>(3)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn recent_events(
    db: &super::Db,
    sources: &[String],
    provider: Option<&str>,
    limit: u64,
) -> Result<Vec<UsageEventRow>> {
    if sources.is_empty() || limit == 0 {
        return Ok(Vec::new());
    }
    let placeholders = std::iter::repeat_n("?", sources.len())
        .collect::<Vec<_>>()
        .join(",");
    let prov_clause = provider.map(|_| " AND provider = ?").unwrap_or("");
    let sql = format!(
        "SELECT source, source_message_id, timestamp_ms, provider, model,
                prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens,
                total_tokens, cost_usd, cost_origin
         FROM usage_events
         WHERE source IN ({placeholders}){prov_clause}
         ORDER BY timestamp_ms DESC
         LIMIT ?"
    );
    let conn = db.conn.lock();
    let mut stmt = conn.prepare(&sql)?;
    let mut plist: Vec<Box<dyn rusqlite::ToSql>> = Vec::with_capacity(sources.len() + 1 + 1);
    for s in sources {
        plist.push(Box::new(s.clone()));
    }
    if let Some(p) = provider {
        plist.push(Box::new(p));
    }
    plist.push(Box::new(limit as i64));
    let refs: Vec<&dyn rusqlite::ToSql> = plist.iter().map(|b| b.as_ref() as &dyn rusqlite::ToSql).collect();
    let rows = stmt.query_map(rusqlite::params_from_iter(refs), |r| {
        Ok(UsageEventRow {
            source: r.get(0)?,
            source_message_id: r.get(1)?,
            timestamp_ms: r.get(2)?,
            provider: r.get(3)?,
            model: r.get(4)?,
            prompt_tokens: r.get(5)?,
            completion_tokens: r.get(6)?,
            cache_read_tokens: r.get(7)?,
            cache_write_tokens: r.get(8)?,
            total_tokens: r.get(9)?,
            cost_usd: r.get(10)?,
            cost_origin: r.get(11)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}