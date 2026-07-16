use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Paragraph};
use ratatui::Frame;

use super::super::app::App;
use super::super::{theme, widgets};
use crate::report::format::truncate;
use crate::usage::UsageReport;

pub fn draw(frame: &mut Frame, app: &App) {
    let Some(provider) = app.current_provider() else {
        let p = Paragraph::new("no provider selected (press esc)").block(Block::bordered());
        frame.render_widget(p, frame.area());
        return;
    };
    let n_windows = provider.reports.iter().map(|r| r.limits.len() as u16 + 1).sum::<u16>();
    let chunks = Layout::vertical([
        Constraint::Length(3),
        Constraint::Min(1),
        Constraint::Length(n_windows.max(1) + 2),
        Constraint::Length(1),
    ])
    .split(frame.area());

    draw_header(frame, chunks[0], provider.provider_label.as_str(), &provider.reports);
    draw_chart(frame, chunks[1], provider.provider_label.as_str(), &provider.reports);
    draw_windows(frame, chunks[2], &provider.reports);
    draw_footer(frame, chunks[3]);
}

fn draw_header(frame: &mut Frame, area: Rect, provider_label: &str, reports: &[UsageReport]) {
    let frac = reports
        .iter()
        .flat_map(|r| r.limits.iter())
        .filter_map(|l| l.amount.used_fraction)
        .max_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
        .unwrap_or(0.0);
    let title = format!(
        "{}  ·  {} account(s)  ·  hottest limit: {:.0}%  ·  fetched {}",
        provider_label,
        reports.len(),
        frac * 100.0,
        epoch_to_clock(reports.iter().map(|r| r.fetched_at).max().unwrap_or(0)),
    );
    let p = Paragraph::new(Line::from(Span::styled(
        title,
        Style::default().fg(theme::color_for(&reports.first().map(|r| r.provider.as_str()).unwrap_or(""))),
    )))
    .block(Block::bordered());
    frame.render_widget(p, area);
}

fn draw_chart(frame: &mut Frame, area: Rect, provider_label: &str, reports: &[UsageReport]) {
    let section = crate::tui::app::ProviderSection {
        provider_id: reports.first().map(|r| r.provider.clone()).unwrap_or_default(),
        provider_label: provider_label.to_string(),
        reports: reports.to_vec(),
        fetched_at: reports.iter().map(|r| r.fetched_at).max().unwrap_or(0),
    };
    let data = widgets::capacity_bars(&[section]);
    if data.is_empty() {
        let p = Paragraph::new("no limits reported")
            .block(Block::bordered().title(Line::from(format!("{} · limits", provider_label))))
            .style(Style::default().fg(theme::MUTED));
        frame.render_widget(p, area);
        return;
    }
    let title = format!("{} · limits", provider_label);
    let chart = widgets::capacity_chart(&data, &title);
    frame.render_widget(chart, area);
}

fn draw_windows(frame: &mut Frame, area: Rect, reports: &[UsageReport]) {
    let mut lines: Vec<Line> = Vec::new();
    for report in reports {
        lines.push(Line::from(Span::styled(format!("  ● {}", report.account), Style::default().add_modifier(ratatui::style::Modifier::BOLD))));
        lines.extend(widgets::account_windows(report));
    }
    let p = Paragraph::new(lines).block(Block::bordered().title("accounts"));
    frame.render_widget(p, area);
}

fn draw_footer(frame: &mut Frame, area: Rect) {
    let p = Paragraph::new(" esc back · ↑↓ switch provider · r sync · h help · q quit ")
        .style(Style::default().fg(theme::MUTED));
    frame.render_widget(p, area);
}

fn epoch_to_clock(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|t| t.format("%H:%M:%S UTC").to_string())
        .unwrap_or_else(|| "?".into())
}

// Avoid unused-import noise from the report-format module.
#[allow(unused_imports)]
use truncate as _truncate_keep;
