use chrono::{DateTime, Utc};

use crate::config::{Config, ProviderCfg};
use crate::db::Db;

pub mod format;
pub mod snapshot;

#[cfg(test)]
mod tests;

pub fn render_report(db: &Db, cfg: &Config, now: DateTime<Utc>) -> String {
    let snap = snapshot::build(db, cfg, now);
    let mut s = String::new();
    s.push_str(&format!(
        "today: {} req  {} tok  ${:.2}\n",
        snap.today.requests, format::fmt_tokens(snap.today.total), snap.today.cost
    ));
    s.push_str("---\n");
    for (prov, view) in cfg
        .providers
        .iter()
        .zip(snap.providers.iter())
        .filter(|(_, v)| v.enabled)
    {
        if let Some(line) = render_line(prov, view, now) {
            s.push_str(&line);
            s.push('\n');
        }
    }
    s
}


fn render_line(prov: &ProviderCfg, view: &snapshot::ProviderView, now: DateTime<Utc>) -> Option<String> {
    let w = view.soonest();
    let aw = w.active.as_ref()?;
    Some(format!(
        "{id}   [{win}]   resets in {re}   {bar} {pct:>3}%  ·  {used} {cost}",
        id = view.id,
        win = w.desc,
        re = format::fmt_duration((aw.next_reset - now).num_seconds().max(0)),
        bar = format::bar(w.pct),
        pct = w.pct.round() as i64,
        used = format::used_str(prov, &w.usage),
        cost = format::cost_str(prov, &w.usage),
    ))
}