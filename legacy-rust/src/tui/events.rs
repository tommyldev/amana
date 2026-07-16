#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key {
    Quit,
    Up,
    Down,
    Enter,
    Back,
    SyncNow,
    Help,
    Tab,
}

pub fn map(ev: &crossterm::event::Event) -> Option<Key> {
    use crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
    let Event::Key(KeyEvent { code, modifiers, kind, .. }) = ev else {
        return None;
    };
    // Ignore key-up events; only act on press.
    if !matches!(kind, KeyEventKind::Press) {
        return None;
    }
    if modifiers.contains(KeyModifiers::CONTROL) {
        if let KeyCode::Char('c') = code {
            return Some(Key::Quit);
        }
    }
    match code {
        KeyCode::Char('q') => Some(Key::Quit),
        KeyCode::Esc | KeyCode::Left | KeyCode::Backspace => Some(Key::Back),
        KeyCode::Enter | KeyCode::Right | KeyCode::Char('l') => Some(Key::Enter),
        KeyCode::Up | KeyCode::Char('k') => Some(Key::Up),
        KeyCode::Down | KeyCode::Char('j') => Some(Key::Down),
        KeyCode::Char('h') | KeyCode::Char('?') => Some(Key::Help),
        KeyCode::Tab => Some(Key::Tab),
        _ => None,
    }
}