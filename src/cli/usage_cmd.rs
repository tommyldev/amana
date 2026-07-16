//! `atop usage` — fetch live provider usage/quota with atop's own credentials
//! and print a compact text report (plus a JSON report under `--json`).
use anyhow::Result;
use clap::Args;
use serde::Serialize;

use crate::auth::store as cred_store;
use crate::db::Db;
use crate::usage::orchestrator::Orchestrator;
use crate::usage::{UsageLimit, UsageReport, UsageUnit};

#[derive(Args, Debug)]
pub struct UsageCmd {
    /// Emit machine-readable JSON instead of the text report.
    #[arg(long)]
    pub json: bool,
    /// Restrict to a specific provider id (default: all with stored credentials).
    #[arg(long)]
    pub provider: Option<String>,
}

pub async fn run(args: UsageCmd, db: &Db) -> Result<()> {
    let providers: Vec<&str> = match &args.provider {
        Some(p) => vec![p.as_str()],
        None => cred_store::all_providers(db)?,
    };
    if providers.is_empty() {
        anyhow::bail!("no providers have stored credentials; run `atop login <provider>` first");
    }
    let orch = Orchestrator::new();
    let result = orch.fetch_all(db, &providers).await?;
    if !result.errors.is_empty() {
        eprintln!("atop: {} fetch error(s):", result.errors.len());
        for e in &result.errors {
            eprintln!("  - {} ({}): {}", e.provider, e.account, e.message);
        }
    }
    if result.reports.is_empty() {
        println!("atop: no usage reports returned (login first or check network)");
        return Ok(());
    }
    if args.json {
        let out: Vec<JsonReport> = result.reports.iter().map(JsonReport::from).collect();
        println!("{}", serde_json::to_string_pretty(&out)?);
    } else {
        for r in &result.reports {
            print_text(r);
        }
    }
    Ok(())
}

fn print_text(r: &UsageReport) {
    println!("{} — {}", r.provider, r.account);
    for l in &r.limits {
        print_limit(l);
    }
    println!();
}

fn print_limit(l: &UsageLimit) {
    let pct = l
        .amount
        .used_fraction
        .map(|f| format!("{:.0}%", f * 100.0))
        .unwrap_or_else(|| "?".into());
    let used = l
        .amount
        .used
        .map(|v| format!("{:.0}", v))
        .unwrap_or_else(|| "?".into());
    let limit = l
        .amount
        .limit
        .map(|v| format!("{:.0}", v))
        .unwrap_or_else(|| "?".into());
    let unit = l.amount.unit.short();
    let win = l
        .window
        .as_ref()
        .map(|w| format!("{} ({})", w.label, w.id))
        .unwrap_or_default();
    let reset = l
        .window
        .as_ref()
        .and_then(|w| w.resets_at)
        .map(epoch_to_iso)
        .unwrap_or_default();
    let tier = l
        .tier
        .as_deref()
        .map(|t| format!(" [{t}]"))
        .unwrap_or_default();
    println!(
        "  {label}{tier}  {win:>10}  {used}/{limit} {unit}  ({pct})  resets {reset}",
        label = l.label,
        win = win,
        used = used,
        limit = limit,
        unit = unit,
        pct = pct,
        reset = reset
    );
}

fn epoch_to_iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|t| t.format("%Y-%m-%d %H:%M UTC").to_string())
        .unwrap_or_else(|| "?".into())
}

#[derive(Serialize)]
struct JsonReport {
    provider: String,
    account: String,
    fetched_at: i64,
    limits: Vec<JsonLimit>,
}

#[derive(Serialize)]
struct JsonLimit {
    id: String,
    label: String,
    tier: Option<String>,
    status: String,
    used: Option<f64>,
    limit: Option<f64>,
    used_fraction: Option<f64>,
    unit: &'static str,
    window_label: Option<String>,
    window_resets_at: Option<i64>,
}

impl From<&UsageReport> for JsonReport {
    fn from(r: &UsageReport) -> Self {
        Self {
            provider: r.provider.clone(),
            account: r.account.clone(),
            fetched_at: r.fetched_at,
            limits: r.limits.iter().map(JsonLimit::from).collect(),
        }
    }
}

impl From<&UsageLimit> for JsonLimit {
    fn from(l: &UsageLimit) -> Self {
        Self {
            id: l.id.clone(),
            label: l.label.clone(),
            tier: l.tier.clone(),
            status: format!("{:?}", l.status).to_lowercase(),
            used: l.amount.used,
            limit: l.amount.limit,
            used_fraction: l.amount.used_fraction,
            unit: l.amount.unit.short(),
            window_label: l.window.as_ref().map(|w| w.label.clone()),
            window_resets_at: l.window.as_ref().and_then(|w| w.resets_at),
        }
    }
}

/// Helper: silence unused import warning when `UsageUnit` is only re-exported.
#[allow(dead_code)]
fn _force_unit() -> UsageUnit {
    UsageUnit::Percent
}
