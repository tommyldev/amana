use chrono::Utc;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Bar, BarChart, Block};

use super::app::{ProviderSection, WindowCapacity};
use super::theme;
use crate::report::format::{bar as ascii_bar, fmt_duration, truncate};
use crate::usage::{UsageAmount, UsageLimit, UsageReport};

pub fn provider_section_lines(section: &ProviderSection, selected: bool) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    let marker = if selected { "▾" } else { "▸" };
    lines.push(Line::from(vec![
        Span::styled(
            format!("{marker} {}", section.provider_label),
            Style::default()
                .fg(theme::color_for(&section.provider_id))
                .add_modifier(if selected { Modifier::BOLD } else { Modifier::empty() }),
        ),
        Span::styled(
            format!(" — {} {}", section.account_count(), if section.account_count() == 1 { "account" } else { "accounts" }),
            Style::default().fg(theme::MUTED),
        ),
    ]));

    for report in &section.reports {
        lines.push(account_header(report));
        for limit in &report.limits {
            lines.push(limit_line(limit, Utc::now().timestamp_millis()));
        }
        if report.limits.is_empty() {
            lines.push(Line::from(Span::styled("      no limits reported", Style::default().fg(theme::MUTED))));
        }
    }

    let caps = section.capacity_summary();
    if !caps.is_empty() {
        lines.push(capacity_line(&caps));
    }
    lines
}

pub fn capacity_bars(sections: &[ProviderSection]) -> Vec<(String, u64, String, Color)> {
    sections
        .iter()
        .filter_map(|section| {
            section
                .reports
                .iter()
                .flat_map(|r| r.limits.iter())
                .filter_map(|l| l.amount.used_fraction.map(|f| (f, l.window.as_ref().map(|w| w.label.clone()).unwrap_or_default())))
                .max_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal))
                .map(|(frac, win)| {
                    (
                        truncate(&section.provider_label, 14),
                        (frac * 100.0).round() as u64,
                        win,
                        theme::color_for(&section.provider_id),
                    )
                })
        })
        .collect()
}

pub fn capacity_chart<'a>(data: &'a [(String, u64, String, Color)], title: &'a str) -> BarChart<'a> {
    let bars: Vec<Bar> = data
        .iter()
        .map(|(label, value, win, _color)| {
            Bar::default().value(*value).label(Line::from(label.as_str())).text_value(win.clone())
        })
        .collect();
    BarChart::new(bars).bar_width(3).bar_gap(1).block(Block::bordered().title(Line::from(title)))
}

pub fn token_chart(
    values: &[u64],
    start_ms: i64,
    bucket_ms: i64,
    title: String,
    color: Color,
) -> BarChart<'static> {
    let bars: Vec<Bar> = values
        .iter()
        .enumerate()
        .map(|(i, v)| {
            let ts = start_ms + i as i64 * bucket_ms;
            let label = chrono::DateTime::from_timestamp_millis(ts)
                .map(|t| t.format("%H").to_string())
                .unwrap_or_default();
            Bar::default()
                .value(*v)
                .label(Line::from(label))
                .text_value(String::new())
                .style(Style::default().fg(color))
        })
        .collect();
    BarChart::new(bars)
        .bar_width(3)
        .bar_gap(0)
        .block(Block::bordered().title(Line::from(title)))
}

pub fn account_windows(report: &UsageReport) -> Vec<Line<'static>> {
    let now = Utc::now().timestamp_millis();
    report.limits.iter().map(|l| limit_line(l, now)).collect()
}

fn account_header(report: &UsageReport) -> Line<'static> {
    Line::from(vec![
        Span::styled("  ● ", Style::default().fg(theme::color_for(&report.provider))),
        Span::styled(report.account.clone(), Style::default().add_modifier(Modifier::BOLD)),
    ])
}

fn limit_line(limit: &UsageLimit, now: i64) -> Line<'static> {
    let pct = limit.amount.used_fraction.unwrap_or(0.0);
    let pct_color = pct_color_for(pct);
    let reset = limit
        .window
        .as_ref()
        .and_then(|w| w.resets_at)
        .map(|r| fmt_duration(((r - now) / 1000).max(0)))
        .map(|d| format!("resets in {d}"))
        .unwrap_or_default();
    let (used, limit_str, unit) = amount_str(&limit.amount);
    let mut suffix = format!("{} used", format!("{:.1}%", pct * 100.0));
    if used != "-" || limit_str != "-" {
        suffix = format!("{used} / {limit_str} {unit} · {suffix}");
    }
    if !reset.is_empty() {
        suffix = format!("{suffix} · {reset}");
    }
    Line::from(vec![
        Span::raw(format!("      {:<28} ", limit.label)),
        Span::styled(ascii_bar(pct * 100.0), Style::default().fg(pct_color)),
        Span::raw(format!("  {suffix}")),
    ])
}

fn capacity_line(caps: &[WindowCapacity]) -> Line<'static> {
    let text = caps
        .iter()
        .map(|c| {
            format!(
                "{} → {:.2}/{} accounts used ({:.2}× quota left)",
                c.key,
                c.used_accounts,
                c.accounts,
                c.remaining_accounts()
            )
        })
        .collect::<Vec<_>>()
        .join(" · ");
    Line::from(Span::styled(format!("  capacity: {text}"), Style::default().fg(theme::MUTED)))
}

fn pct_color_for(pct: f64) -> Color {
    if pct >= 0.9 {
        Color::Red
    } else if pct >= 0.7 {
        Color::Yellow
    } else {
        Color::Green
    }
}

fn amount_str(a: &UsageAmount) -> (String, String, &'static str) {
    let used = a.used.map(|v| format_number(v)).unwrap_or_else(|| "-".into());
    let limit = a.limit.map(|v| format_number(v)).unwrap_or_else(|| "-".into());
    (used, limit, a.unit.short())
}

fn format_number(v: f64) -> String {
    if (v - v.round()).abs() < 0.0001 {
        format!("{:.0}", v)
    } else {
        format!("{:.1}", v)
    }
}
