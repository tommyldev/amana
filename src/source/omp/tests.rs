use super::*;
use std::io::Write;

#[tokio::test]
async fn ingests_one_assistant_message() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("sessions/2026-06-27");
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("a.jsonl");
    let mut f = std::fs::File::create(&file).unwrap();
    writeln!(f, r#"{{"type":"message","id":"x","message":{{"role":"user","content":"hi"}}}}"#).unwrap();
    writeln!(f, r#"{{"type":"message","id":"y","message":{{"role":"assistant","model":"claude-3-5-sonnet-20240620","provider":"anthropic","usage":{{"input":100,"output":50,"cacheRead":0,"cacheWrite":0,"cost":{{"total":0.0012}}}},"timestamp":"2026-06-27T10:00:00Z"}}}}"#).unwrap();
    drop(f);

    let db_path = tmp.path().join("atop.db");
    let db = Db::open(&db_path).unwrap();
    let src = OmpSource { root: tmp.path().join("sessions") };
    let out = src.fetch(&db, &ProviderCfg::for_id("omp")).await.unwrap();
    assert_eq!(out.inserted, 1);
    assert_eq!(out.status, "ok");

    let out2 = src.fetch(&db, &ProviderCfg::for_id("omp")).await.unwrap();
    assert_eq!(out2.inserted, 0);
}

#[test]
fn parse_real_omp_line() {
    // This is a real omp session file line (assistant message with usage).
    let line = br#"{"type":"message","id":"bf8a1e10","message":{"role":"assistant","model":"MiniMax-M2.7-highspeed","provider":"minimax-code","usage":{"input":22947,"output":46,"cacheRead":0,"cacheWrite":0,"totalTokens":22993,"reasoningTokens":37,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"timestamp":1778936729894,"stopReason":"toolUse","duration":1234,"ttft":56}}"#;
    let row = super::parse::parse_line(line).expect("parser should extract event");
    assert_eq!(row.provider, "minimax-code");
    assert_eq!(row.model, "MiniMax-M2.7-highspeed");
    assert_eq!(row.total_tokens, 22993);
    assert_eq!(row.source, "omp");
}


