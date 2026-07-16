use ratatui::layout::Rect;
use ratatui::Frame;

use super::app::{App, Mode};

mod holistic;
mod provider;
mod tokens;

pub fn draw(frame: &mut Frame, app: &App) {
    match app.mode {
        Mode::Holistic => holistic::draw(frame, app),
        Mode::Provider(_) => provider::draw(frame, app),
        Mode::Tokens => tokens::draw_overview(frame, app),
        Mode::TokenProvider(_) => tokens::draw_provider(frame, app),
    }
    if app.show_help {
        let area = frame.area();
        draw_help_overlay(frame, area);
    }
}

fn draw_help_overlay(frame: &mut Frame, area: Rect) {
    use ratatui::layout::Margin;
    use ratatui::text::Line;
    use ratatui::widgets::{Block, Borders, Clear, Paragraph};
    let w = (area.width as i32 - 10).max(20) as u16;
    let h = 12u16;
    let x = area.x + (area.width.saturating_sub(w)) / 2;
    let y = area.y + (area.height.saturating_sub(h)) / 2;
    let r = Rect::new(x, y, w, h);
    frame.render_widget(Clear, r);
    let lines = vec![
        Line::from(" atop — keys "),
        Line::from(""),
        Line::from("  q / Ctrl-C        quit"),
        Line::from("  ↑/k   ↓/j         select provider"),
        Line::from("  tab               switch tokens / live"),
        Line::from("  Enter / → / l     open provider"),
        Line::from("  Esc / ← / ⌫       back"),
        Line::from("  r                 sync now"),
        Line::from("  h / ?             toggle this help"),
    ];
    let p = Paragraph::new(lines).block(Block::default().borders(Borders::ALL));
    frame.render_widget(p, r.inner(Margin { vertical: 0, horizontal: 0 }));
}
