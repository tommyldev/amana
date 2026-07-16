use crate::model::UsageEventRow;

fn row(source: &str, mid: &str, ts: i64, total: i64, cost: Option<f64>) -> UsageEventRow {
    UsageEventRow {
        source: source.into(),
        source_message_id: mid.into(),
        timestamp_ms: ts,
        provider: "test".into(),
        model: "test-model".into(),
        prompt_tokens: 10,
        completion_tokens: 20,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        total_tokens: total,
        cost_usd: cost,
        cost_origin: "logged".into(),
    }
}

#[test]
fn window_usage_aggregates_only_in_range() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("atop.db");
    let db = super::Db::open(&path).unwrap();
    let src = "test".to_string();
    let rows = vec![
        row("test", "a", 100, 100, Some(0.10)),
        row("test", "b", 200, 200, Some(0.20)),
        row("test", "c", 1000, 999, Some(0.99)),
    ];
    db.insert_events(rows).unwrap();
    let agg = db.window_usage(0, 500, &[src], None).unwrap();
    assert_eq!(agg.total, 300);
    assert_eq!(agg.requests, 2);
    assert!((agg.cost - 0.30).abs() < 1e-9);
}

#[test]
fn dedup_keeps_larger_completion() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("atop.db");
    let db = super::Db::open(&path).unwrap();
    let mut a = row("cc", "uuid-1", 1, 11, Some(0.10));
    a.completion_tokens = 1;
    let mut b = row("cc", "uuid-1", 1, 11, Some(0.10));
    b.completion_tokens = 4200;
    db.insert_events_dedup_completion(vec![a, b]).unwrap();
    let agg = db.window_usage(0, 1000, &["cc".into()], None).unwrap();
    assert_eq!(agg.completion, 4200);
}

#[test]
fn window_series_buckets_by_time() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("atop.db");
    let db = super::Db::open(&path).unwrap();
    // 4 buckets spanning 0..400 ms. step = 400/4 = 100. bucket index = (ts - 0) / 100.
    let src = "test".to_string();
    let rows = vec![
        row("test", "a",  50, 100, Some(0.10)), // bucket 0
        row("test", "b", 110, 200, Some(0.20)), // bucket 1
        row("test", "c", 150, 300, Some(0.30)), // bucket 1
        row("test", "d", 250, 400, Some(0.40)), // bucket 2
    ];
    db.insert_events(rows).unwrap();
    let buckets = 4;
    let series = db.window_series(0, 400, &[src.clone()], None, buckets).unwrap();
    assert_eq!(series.len(), buckets);
    assert_eq!(series[0], 100);
    assert_eq!(series[1], 500);
    assert_eq!(series[2], 400);
    assert_eq!(series[3], 0);
}

#[test]
fn breakdown_orders_by_tokens_desc() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("atop.db");
    let db = super::Db::open(&path).unwrap();
    let src = "test".to_string();
    let mut r1 = row("test", "a", 50, 100, Some(0.10));
    r1.model = "small".into();
    let mut r2 = row("test", "b", 60, 200, Some(0.20));
    r2.model = "small".into();
    let mut r3 = row("test", "c", 70, 500, Some(0.50));
    r3.model = "big".into();
    db.insert_events(vec![r1, r2, r3]).unwrap();
    let bd = db.breakdown_by_model(0, 1000, &[src], None).unwrap();
    assert_eq!(bd.len(), 2);
    assert_eq!(bd[0].model, "big");
    assert_eq!(bd[0].total_tokens, 500);
    assert_eq!(bd[1].model, "small");
    assert_eq!(bd[1].requests, 2);
}

#[test]
fn recent_events_returns_newest_first() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("atop.db");
    let db = super::Db::open(&path).unwrap();
    let src = "test".to_string();
    let rows = vec![
        row("test", "a",  50, 100, Some(0.10)),
        row("test", "b", 200, 200, Some(0.20)),
        row("test", "c", 150, 300, Some(0.30)),
    ];
    db.insert_events(rows).unwrap();
    let r = db.recent_events(&[src], None, 2).unwrap();
    assert_eq!(r.len(), 2);
    assert_eq!(r[0].source_message_id, "b"); // ts=200 newest
    assert_eq!(r[1].source_message_id, "c"); // ts=150 next
}

#[test]
fn window_usage_filters_by_provider() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("atop.db");
    let db = super::Db::open(&path).unwrap();
    // Two providers sharing the "omp" source, distinguished by the `provider` column.
    let mut a = row("omp", "a", 100, 100, Some(0.10));
    a.provider = "anthropic".into();
    let mut b = row("omp", "b", 200, 200, Some(0.20));
    b.provider = "github-copilot".into();
    db.insert_events(vec![a, b]).unwrap();
    // Without provider filter: sum of both.
    let all = db.window_usage(0, 1000, &["omp".into()], None).unwrap();
    assert_eq!(all.total, 300);
    // With provider filter: only matching rows.
    let copilot = db.window_usage(0, 1000, &["omp".into()], Some("github-copilot")).unwrap();
    assert_eq!(copilot.total, 200);
    assert_eq!(copilot.requests, 1);
    let anthropic = db.window_usage(0, 1000, &["omp".into()], Some("anthropic")).unwrap();
    assert_eq!(anthropic.total, 100);
}

#[test]
fn hourly_by_provider_buckets_and_costs() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("atop.db");
    let db = super::Db::open(&path).unwrap();
    let mut a1 = UsageEventRow {
        source: "omp".into(),
        source_message_id: "a1".into(),
        timestamp_ms: 50,
        provider: "a".into(),
        model: "m".into(),
        prompt_tokens: 0,
        completion_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        total_tokens: 100,
        cost_usd: Some(0.10),
        cost_origin: "logged".into(),
    };
    let mut a2 = UsageEventRow {
        source: "omp".into(),
        source_message_id: "a2".into(),
        timestamp_ms: 150,
        provider: "a".into(),
        model: "m".into(),
        prompt_tokens: 0,
        completion_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        total_tokens: 300,
        cost_usd: Some(0.30),
        cost_origin: "logged".into(),
    };
    let mut b1 = UsageEventRow {
        source: "omp".into(),
        source_message_id: "b1".into(),
        timestamp_ms: 250,
        provider: "b".into(),
        model: "m".into(),
        prompt_tokens: 0,
        completion_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        total_tokens: 400,
        cost_usd: None,
        cost_origin: "logged".into(),
    };
    db.insert_events(vec![a1, a2, b1]).unwrap();
    let out = db.hourly_by_provider(0, 100, 4).unwrap();
    assert_eq!(out.len(), 2);
    let a = &out[0];
    assert_eq!(a.provider, "a");
    assert_eq!(a.total_tokens, 400);
    assert!((a.est_cost - 0.40).abs() < 1e-9);
    assert_eq!(a.buckets, vec![100, 300, 0, 0]);
    let b = &out[1];
    assert_eq!(b.provider, "b");
    assert_eq!(b.total_tokens, 400);
    assert_eq!(b.est_cost, 0.0);
    assert_eq!(b.buckets, vec![0, 0, 400, 0]);
}