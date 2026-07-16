use ratatui::style::{Color, Modifier, Style};

/// Color band for usage gauges. <70 green, 70..90 yellow, >=90 red.
pub fn gauge_color(pct: f64) -> Color {
    if pct >= 90.0 { Color::Red }
    else if pct >= 70.0 { Color::Yellow }
    else { Color::Green }
}

pub const SELECTED: Style = Style::new().add_modifier(Modifier::BOLD).fg(Color::Cyan);
pub const HEADER: Style = Style::new().add_modifier(Modifier::BOLD);
pub const MUTED: Color = Color::DarkGray;

/// btop-style color band cycled per provider so each row/chart is visually
/// distinct. Indexed by the provider's position in `KNOWN_PROVIDERS` so the
/// color is stable across runs.
pub const PALETTE: &[Color] = &[
    Color::Cyan,
    Color::Green,
    Color::Yellow,
    Color::Magenta,
    Color::Blue,
    Color::LightRed,
    Color::LightCyan,
    Color::LightGreen,
    Color::LightYellow,
    Color::LightMagenta,
    Color::LightBlue,
    Color::Red,
];

pub fn color_for(id: &str) -> Color {
    let idx = crate::registry::KNOWN_PROVIDERS
        .iter()
        .position(|p| p.id == id)
        .unwrap_or_else(|| id.bytes().map(|b| b as usize).sum());
    PALETTE[idx % PALETTE.len()]
}