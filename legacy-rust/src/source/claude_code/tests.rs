use super::*;
use std::io::Write;

#[tokio::test]
async fn dedups_streaming_and_keeps_max() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("projects/abc");
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("a.jsonl");
    let mut f = std::fs::File::create(&file).unwrap();
    writeln!(f, r#"{{"type":"assistant","uuid":"u1","timestamp":"2026-06-27T10:00:00Z","message":{{"role":"assistant","model":"claude-3-5-sonnet-20240620","usage":{{"input_tokens":100,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}}}}"#).unwrap();
    writeln!(f, r#"{{"type":"assistant","uuid":"u1","timestamp":"2026-06-27T10:00:01Z","message":{{"role":"assistant","model":"claude-3-5-sonnet-20240620","usage":{{"input_tokens":100,"output_tokens":4200,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}}}}"#).unwrap();
    writeln!(f, r#"{{"type":"assistant","uuid":"u2","timestamp":"2026-06-27T10:01:00Z","message":{{"role":"assistant","model":"claude-3-5-sonnet-20240620","usage":{{"input_tokens":50,"output_tokens":30,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}}}}"#).unwrap();
    drop(f);

    let db_path = tmp.path().join("atop.db");
    let db = Db::open(&db_path).unwrap();
    let src = ClaudeCodeSource { root: tmp.path().join("projects") };
    let out = src.fetch(&db, &ProviderCfg::for_id("claude-code")).await.unwrap();
    assert_eq!(out.inserted, 3);
    let agg = db.window_usage(0, i64::MAX, &["claude-code".into()], None).unwrap();
    assert_eq!(agg.completion, 4200 + 30);
    let n: i64 = db.count_source("claude-code").unwrap();
    assert_eq!(n, 2);
}
