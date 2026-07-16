use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Paragraph};
use ratatui::Frame;

use super::super::app::{App, TOKEN_BUCKETS, TOKEN_BUCKET_MS};
use super::super::{theme, widgets};
use crate::report::format::{fmt_tokens, truncate};

fn grand_tokens(app: &App) -> u64 {
    app.token_providers.iter().map(|p| p.total_tokens).sum()
}

fn grand_cost(app: &App) -> f64 {
    app.token_providers.iter().map(|p| p.est_cost).sum()
}

fn label_for(id: &str) -> String {
    crate::registry::by_id(id)
        .map(|d| d.label.to_string())
        .unwrap_or_else(|| id.to_string())
}

pub fn draw_overview(frame: &mut Frame, app: &App) {
    let chunks = Layout::vertical([
        Constraint::Length(3),
        Constraint::Length(13),
        Constraint::Min(1),
        Constraint::Length(1),
    ])
    .split(frame.area());

    draw_overview_header(frame, chunks[0], app);
    draw_overview_chart(frame, chunks[1], app);
    draw_overview_table(frame, chunks[2], app);
    draw_overview_footer(frame, chunks[3]);
}

fn draw_overview_header(frame: &mut Frame, area: Rect, app: &App) {
    let title = format!(
        "Token usage · last {}h · {} tok · est ${:.2}",
        TOKEN_BUCKETS,
        fmt_tokens(grand_tokens(app) as i64),
        grand_cost(app)
    );
    let p = Paragraph::new(Line::from(title))
        .block(Block::bordered())
        .style(theme::HEADER);
    frame.render_widget(p, area);
}

fn draw_overview_chart(frame: &mut Frame, area: Rect, app: &App) {
    if app.token_providers.is_empty() {
        let p = Paragraph::new("no token usage recorded yet — run `atop sync`")
            .block(Block::bordered().title(Line::from("all providers · tokens / hour")))
            .style(Style::default().fg(theme::MUTED));
        frame.render_widget(p, area);
        return;
    }
    let chart = widgets::token_chart(
        &app.token_total,
        app.token_start_ms,
        TOKEN_BUCKET_MS,
        "all providers · tokens / hour".into(),
        theme::color_for(""),
    );
    frame.render_widget(chart, area);
}

fn draw_overview_table(frame: &mut Frame, area: Rect, app: &App) {
    let grand_tok = grand_tokens(app);
    let grand_c = grand_cost(app);
    let mut lines: Vec<Line> = Vec::new();
    for (i, p) in app.token_providers.iter().enumerate() {
        let marker = if i == app.token_selected { "▸" } else { " " };
        let mut style = Style::default().fg(theme::color_for(&p.provider));
        if i == app.token_selected {
            style = style.add_modifier(Modifier::BOLD);
        }
        let label = truncate(&label_for(&p.provider), 16);
        lines.push(Line::from(Span::styled(
            format!(
                "{} {:<16} {:>9} tok   est ${:.2}",
                marker,
                label,
                fmt_tokens(p.total_tokens as i64),
                p.est_cost
            ),
            style,
        )));
    }
    lines.push(Line::from(Span::styled(
        format!(
            "  {:<16} {:>9} tok   est ${:.2}",
            "TOTAL",
            fmt_tokens(grand_tok as i64),
            grand_c
        ),
        Style::default().fg(theme::MUTED),
    )));
    let p = Paragraph::new(lines).block(Block::bordered().title("providers"));
    frame.render_widget(p, area);
}

fn draw_overview_footer(frame: &mut Frame, area: Rect) {
    let p = Paragraph::new(" ↑↓ select · enter drill · tab live · r sync · q quit ")
        .style(Style::default().fg(theme::MUTED));
    frame.render_widget(p, area);
}

pub fn draw_provider(frame: &mut Frame, app: &App) {
    let Some(p) = app.token_providers.get(app.token_selected) else {
        draw_overview(frame, app);
        return;
    };
    let chunks = Layout::vertical([
        Constraint::Length(3),
        Constraint::Min(1),
        Constraint::Length(1),
    ])
    .split(frame.area());

    draw_provider_header(frame, chunks[0], app, p);
    draw_provider_chart(frame, chunks[1], app, p);
    draw_provider_footer(frame, chunks[2]);
}

fn draw_provider_header(frame: &mut Frame, area: Rect, _app: &App, p: &crate::db::ProviderHourly) {
    let title = format!(
        "{} · last {}h · {} tok · est ${:.2}",
        label_for(&p.provider),
        TOKEN_BUCKETS,
        fmt_tokens(p.total_tokens as i64),
        p.est_cost
    );
    let block_color = theme::color_for(&p.provider);
    let p_widget = Paragraph::new(Line::from(Span::styled(
        title,
        Style::default().fg(block_color).add_modifier(Modifier::BOLD),
    )))
    .block(Block::bordered());
    frame.render_widget(p_widget, area);
}

fn draw_provider_chart(
    frame: &mut Frame,
    area: Rect,
    app: &App,
    p: &crate::db::ProviderHourly,
) {
    let chart = widgets::token_chart(
        &p.buckets,
        app.token_start_ms,
        TOKEN_BUCKET_MS,
        label_for(&p.provider),
        theme::color_for(&p.provider),
    );
    frame.render_widget(chart, area);
}

fn draw_provider_footer(frame: &mut Frame, area: Rect) {
    let p = Paragraph::new(" esc back · ↑↓ switch provider · tab live · q quit ")
        .style(Style::default().fg(theme::MUTED));
    frame.render_widget(p, area);
}
