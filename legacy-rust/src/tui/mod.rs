use std::io::{self, Stdout};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use chrono::Utc;
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;

pub mod app;
pub mod data;
pub mod events;
pub mod theme;
pub mod view;
pub mod widgets;

pub async fn run(
    _paths: &crate::config::Paths,
    cfg: crate::config::Config,
    db: crate::db::Db,
) -> Result<()> {
    install_panic_hook();

    let db = Arc::new(db);
    let cfg = Arc::new(cfg);

    // Initial sync so the first frame already has data.
    let _ = crate::sync::run_sync(&db, &cfg, false).await;

    let mut terminal = setup_terminal()?;
    let result = drive(&mut terminal, db, cfg).await;
    restore_terminal()?;
    result
}

/// Install a panic hook that restores the terminal before the default
/// backtrace prints, so a panic inside any TUI loop doesn't strand the
/// user in raw mode / the alternate screen with no visible prompt.
pub(crate) fn install_panic_hook() {
    let prev_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = restore_terminal();
        prev_hook(info);
    }));
}

pub(crate) fn setup_terminal() -> Result<Terminal<CrosstermBackend<Stdout>>> {
    use crossterm::terminal::EnterAlternateScreen;
    crossterm::execute!(io::stdout(), EnterAlternateScreen)?;
    crossterm::terminal::enable_raw_mode()?;
    let backend = CrosstermBackend::new(io::stdout());
    let terminal = Terminal::new(backend)?;
    Ok(terminal)
}

pub(crate) fn restore_terminal() -> Result<()> {
    use crossterm::cursor::Show;
    use crossterm::terminal::{LeaveAlternateScreen, disable_raw_mode};
    let mut stdout = io::stdout();
    // Best-effort: any single step failing must still let the others run so
    // we don't strand the user's shell.
    let _ = crossterm::execute!(stdout, LeaveAlternateScreen, Show);
    disable_raw_mode()?;
    Ok(())
}

async fn drive(
    terminal: &mut Terminal<CrosstermBackend<Stdout>>,
    db: Arc<crate::db::Db>,
    cfg: Arc<crate::config::Config>,
) -> Result<()> {
    use futures::StreamExt;
    use tokio::sync::{mpsc, Notify};

    let mut app = app::App::new(db.clone(), cfg.clone());

    // Background ingestion: single task drains either the interval tick or a
    // force-sync notification, then pushes the result back via mpsc.
    let force = Arc::new(Notify::new());
    let (counts_tx, mut counts_rx) = mpsc::channel::<std::collections::HashMap<String, usize>>(8);
    {
        let db2 = db.clone();
        let cfg2 = cfg.clone();
        let force2 = force.clone();
        let interval_secs = cfg2.ui.refresh_interval_seconds.max(1);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(interval_secs));
            // Skip the immediate first tick (already done an initial sync at startup).
            tick.tick().await;
            loop {
                tokio::select! {
                    _ = tick.tick() => {},
                    _ = force2.notified() => {},
                }
                let counts = crate::sync::run_sync(&db2, &cfg2, false).await.unwrap_or_default();
                if counts_tx.send(counts).await.is_err() {
                    break; // receiver dropped, app exited
                }
            }
        });
    }

    // 1-second render tick drives the live countdown. The background task
    // keeps its own cadence (refresh_interval_seconds, default 60) and triggers
    // a fresh `atop usage` fetch on the same cadence + on `r` (force).
    let mut render_tick = tokio::time::interval(Duration::from_secs(1));
    let mut events = crossterm::event::EventStream::new();

    // Initial fetch so the first frame already has data.
    app.refresh_usage().await;
    app.refresh_tokens();
    app.last_sync_at = Some(Utc::now());
    loop {
        terminal.draw(|f| view::draw(f, &app))?;
        tokio::select! {
            _ = render_tick.tick() => {
                // just redraw — the view recomputes time-of-day on the fly
            }
            maybe_ev = events.next() => {
                match maybe_ev {
                    Some(Ok(ev)) => {
                        if let Some(k) = events::map(&ev) {
                            if !app.handle_key(k) { break; }
                            if matches!(k, events::Key::SyncNow) {
                                force.notify_one();
                            }
                        }
                    }
                    Some(Err(e)) => {
                        eprintln!("event error: {e}");
                    }
                    None => break,
                }
            }
            Some(_) = counts_rx.recv() => {
                app.refresh_usage().await;
                app.refresh_tokens();
                app.last_sync_at = Some(Utc::now());
                app.syncing = false;
            }
        }
    }
    Ok(())
}