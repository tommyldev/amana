//! Smoke test: drive the TUI rendering against a TestBackend to confirm
//! the default token screen renders without panicking, the provider table
//! shows the seeded entry, and mode navigation reaches TokenProvider(_).

use std::sync::Arc;

use atop::config::Config;
use atop::db::Db;
use atop::model::UsageEventRow;
use atop::tui::app::{App, Mode, TOKEN_BUCKETS};
use atop::tui::events::Key;
use atop::tui::view;

fn make_token_row(provider: &str, ts: i64, total: i64, cost: Option<f64>) -> UsageEventRow {
    UsageEventRow {
        source: "omp".into(),
        source_message_id: format!("{provider}-{ts}"),
        timestamp_ms: ts,
        provider: provider.into(),
        model: "m".into(),
        prompt_tokens: 0,
        completion_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        total_tokens: total,
        cost_usd: cost,
        cost_origin: "logged".into(),
    }
}

#[test]
fn tui_tokens_screen_renders_and_navigates() {
    let tmp = tempfile::tempdir().unwrap();
    let db = Db::open(&tmp.path().join("atop.db")).unwrap();

    // One recent event in the current hour so the chart is non-empty.
    let now_ms = chrono::Utc::now().timestamp_millis();
    let bucket_ms = (atop::tui::app::TOKEN_BUCKET_MS) as i64;
    let in_bucket = (now_ms / bucket_ms) * bucket_ms + 60_000;
    db.insert_events(vec![
        make_token_row("anthropic", in_bucket, 1500, Some(0.01)),
    ])
    .unwrap();

    let mut app = App::new(Arc::new(db), Arc::new(Config::default()));
    app.refresh_tokens();
    assert!(matches!(app.mode, Mode::Tokens), "default mode is Tokens");
    assert_eq!(app.token_providers.len(), 1);
    assert_eq!(app.token_providers[0].provider, "anthropic");
    assert!(app.token_providers[0].total_tokens >= 1500);

    // Render the overview against a TestBackend.
    let backend = ratatui::backend::TestBackend::new(100, 30);
    let mut terminal = ratatui::Terminal::new(backend).unwrap();
    terminal
        .draw(|f| view::draw(f, &app))
        .expect("overview renders");

    // Tab → live (Holistic), Tab → tokens, Enter drills in, Esc backs out.
    assert!(app.handle_key(Key::Tab));
    assert_eq!(app.mode, Mode::Holistic);
    assert!(app.handle_key(Key::Tab));
    assert_eq!(app.mode, Mode::Tokens);
    assert!(app.handle_key(Key::Enter));
    assert!(matches!(app.mode, Mode::TokenProvider(0)));
    terminal
        .draw(|f| view::draw(f, &app))
        .expect("provider screen renders");
    assert!(app.handle_key(Key::Back));
    assert_eq!(app.mode, Mode::Tokens);

    // Make sure TOKEN_BUCKETS matches the slice we use in the table.
    assert_eq!(app.token_total.len(), TOKEN_BUCKETS);
}
