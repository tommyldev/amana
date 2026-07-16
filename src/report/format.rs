use crate::config::ProviderCfg;
use crate::model::UsageAggregate;

pub fn fmt_tokens(n: i64) -> String {
    let n = n as f64;
    if n >= 1_000_000.0 {
        format!("{:.1}M", n / 1_000_000.0)
    } else if n >= 1_000.0 {
        format!("{:.1}k", n / 1_000.0)
    } else {
        format!("{n:.0}")
    }
}

pub fn fmt_duration(secs: i64) -> String {
    if secs <= 0 { return "now".into(); }
    let h = secs / 3600;
    let m = (secs % 3600) / 60;
    if h > 24 {
        let d = h / 24;
        let hr = h % 24;
        format!("{d}d {hr:02}h")
    } else if h > 0 {
        format!("{h}h {m:02}m")
    } else {
        format!("{m}m")
    }
}

pub fn bar(pct: f64) -> String {
    let p = (pct / 10.0).round() as i64;
    let p = p.clamp(0, 10);
    let filled = "█".repeat(p as usize);
    let empty = "░".repeat((10 - p) as usize);
    format!("{filled}{empty}")
}

pub fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max { s.to_string() }
    else {
        let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
        out.push('…');
        out
    }
}

pub fn used_str(prov: &ProviderCfg, agg: &UsageAggregate) -> String {
    if let Some(limit) = prov.limits.window_token_limit {
        format!("{} / {} tok", fmt_tokens(agg.total), fmt_tokens(limit as i64))
    } else {
        format!("{} tok", fmt_tokens(agg.total))
    }
}

pub fn cost_str(prov: &ProviderCfg, agg: &UsageAggregate) -> String {
    if let Some(limit) = prov.limits.monthly_cost {
        format!("${:.2} / ${:.2}", agg.cost, limit)
    } else if agg.cost > 0.0 {
        format!("${:.2}", agg.cost)
    } else {
        "-".into()
    }
}

pub fn pct_of(total: i64, limit: Option<u64>) -> f64 {
    limit
        .filter(|l| *l > 0)
        .map(|l| (total as f64 / l as f64 * 100.0).min(100.0))
        .unwrap_or(0.0)
}
