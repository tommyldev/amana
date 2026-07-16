use anyhow::Result;

pub fn window_series(
    db: &super::Db,
    start_ms: i64,
    next_reset_ms: i64,
    sources: &[String],
    provider: Option<&str>,
    buckets: usize,
) -> Result<Vec<u64>> {
    if buckets == 0 || sources.is_empty() {
        return Ok(vec![0u64; buckets.max(0)]);
    }
    let step = ((next_reset_ms - start_ms) / buckets as i64).max(1);
    let placeholders = std::iter::repeat_n("?", sources.len()).collect::<Vec<_>>().join(",");
    let prov_clause = provider.map(|_| " AND provider = ?").unwrap_or("");
    let sql = format!(
        "SELECT (timestamp_ms - ?1) / ?2 AS b, COALESCE(SUM(total_tokens),0)
         FROM usage_events
         WHERE timestamp_ms >= ?1 AND timestamp_ms < ?3
           AND source IN ({placeholders}){prov_clause}
         GROUP BY b"
    );
    let conn = db.conn.lock();
    let mut stmt = conn.prepare(&sql)?;
    let mut out: Vec<u64> = vec![0u64; buckets];
    let mut params: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(3 + sources.len() + 1);
    params.push(&start_ms);
    params.push(&step);
    params.push(&next_reset_ms);
    for s in sources {
        params.push(s);
    }
    if provider.is_some() {
        params.push(&provider);
    }
    let rows = stmt.query_map(rusqlite::params_from_iter(params), |r| {
        let bucket: i64 = r.get(0)?;
        let sum: i64 = r.get(1)?;
        Ok((bucket, sum as u64))
    })?;
    for row in rows {
        let (bucket, sum) = row?;
        let idx = bucket as usize;
        if idx < out.len() {
            out[idx] = sum;
        }
    }
    Ok(out)
}

pub struct ProviderHourly {
    pub provider: String,
    pub buckets: Vec<u64>,
    pub total_tokens: u64,
    pub est_cost: f64,
}

pub fn hourly_by_provider(
    db: &super::Db,
    start_ms: i64,
    bucket_ms: i64,
    buckets: usize,
) -> Result<Vec<ProviderHourly>> {
    use std::collections::BTreeMap;

    if buckets == 0 {
        return Ok(Vec::new());
    }
    let end_ms = start_ms + bucket_ms * buckets as i64;
    let conn = db.conn.lock();
    let mut stmt = conn.prepare(
        "SELECT provider, (timestamp_ms - ?1) / ?2 AS b,
                COALESCE(SUM(total_tokens), 0), COALESCE(SUM(cost_usd), 0.0)
         FROM usage_events
         WHERE timestamp_ms >= ?1 AND timestamp_ms < ?3
         GROUP BY provider, b",
    )?;
    let rows = stmt.query_map(rusqlite::params![start_ms, bucket_ms, end_ms], |r| {
        let provider: String = r.get(0)?;
        let bucket: i64 = r.get(1)?;
        let tok: i64 = r.get(2)?;
        let cost: f64 = r.get(3)?;
        Ok((provider, bucket, tok, cost))
    })?;
    let mut map: BTreeMap<String, ProviderHourly> = BTreeMap::new();
    for row in rows {
        let (provider, b, tok, cost) = row?;
        if b < 0 || (b as usize) >= buckets {
            continue;
        }
        let entry = map.entry(provider.clone()).or_insert_with(|| ProviderHourly {
            provider,
            buckets: vec![0u64; buckets],
            total_tokens: 0,
            est_cost: 0.0,
        });
        entry.buckets[b as usize] = tok as u64;
        entry.total_tokens += tok as u64;
        entry.est_cost += cost;
    }
    let mut out: Vec<ProviderHourly> = map.into_values().collect();
    out.sort_by(|a, b| {
        b.total_tokens
            .cmp(&a.total_tokens)
            .then(a.provider.cmp(&b.provider))
    });
    Ok(out)
}