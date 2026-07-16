use chrono::Utc;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::widgets::{Block, Paragraph};
use ratatui::Frame;

use super::super::app::App;
use super::super::{theme, widgets};

const CHART_TITLE: &str = "live capacity (most-pressured account limit per provider)";

pub fn draw(frame: &mut Frame, app: &App) {
    let chunks = Layout::vertical([
        Constraint::Length(3),
        Constraint::Length(11),
        Constraint::Min(1),
        Constraint::Length(1),
    ])
    .split(frame.area());

    draw_header(frame, chunks[0], app);
    draw_chart(frame, chunks[1], app);
    draw_list(frame, chunks[2], app);
    draw_footer(frame, chunks[3], app);
}

fn draw_header(frame: &mut Frame, area: Rect, app: &App) {
    let now = Utc::now();
    let n = app.providers.len();
    let sync = if app.syncing {
        "syncing…".to_string()
    } else if let Some(latest) = app.providers.iter().map(|p| p.fetched_at).max() {
        let ago = (Utc::now().timestamp_millis() - latest).max(0);
        format!("fetched {} ago", crate::report::format::fmt_duration(ago / 1000))
    } else if let Some(t) = app.last_sync_at {
        format!("last sync {}", t.format("%H:%M:%S"))
    } else {
        String::new()
    };
    let title = format!(
        "Usage  ·  {} provider(s)  ·  {}  ·  {}",
        n,
        now.format("%H:%M:%S"),
        sync,
    );
    let p = Paragraph::new(Line::from(title))
        .block(Block::bordered())
        .style(theme::HEADER);
    frame.render_widget(p, area);
}

fn draw_chart(frame: &mut Frame, area: Rect, app: &App) {
    let data = widgets::capacity_bars(&app.providers);
    if data.is_empty() {
        let p = Paragraph::new("no live usage — run `atop login <provider>` first")
            .block(Block::bordered().title(CHART_TITLE))
            .style(Style::default().fg(theme::MUTED));
        frame.render_widget(p, area);
        return;
    }
    let chart = widgets::capacity_chart(&data, CHART_TITLE);
    frame.render_widget(chart, area);
}
fn draw_list(frame: &mut Frame, area: Rect, app: &App) {
    let lines: Vec<Line> = if app.reports.is_empty() {
        vec![Line::from("  no live usage reports — run `atop login <provider>`")]
    } else {
        app.providers
            .iter()
            .enumerate()
            .flat_map(|(pos, section)| widgets::provider_section_lines(section, pos == app.selected))
            .collect()
    };
    let p = Paragraph::new(lines).block(Block::bordered().title("providers"));
    frame.render_widget(p, area);
}

fn draw_footer(frame: &mut Frame, area: Rect, app: &App) {
    let base = " ↑↓ select · enter open · r sync · h help · q quit ".to_string();
    if app.errors.is_empty() {
        let p = Paragraph::new(base).style(Style::default().fg(theme::MUTED));
        frame.render_widget(p, area);
        return;
    }
    let first = &app.errors[0];
    let suffix = format!(" · {} err", app.errors.len());
    let text = format!("{base} · {first}{suffix}");
    let p = Paragraph::new(text).style(Style::default().fg(theme::MUTED));
    frame.render_widget(p, area);
}
