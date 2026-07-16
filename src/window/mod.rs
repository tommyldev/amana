use chrono::{DateTime, Duration, TimeZone, Utc, Weekday};
use humantime::parse_duration;

use crate::config::{WindowCfg, WindowTypeCfg};

mod helpers;

#[cfg(test)]
mod tests;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WindowKind {
    /// Epoch-grid floor, NOT first-usage anchor. atop's rolling
    /// window is a user-tuned tracking window.
    Rolling { duration: Duration },
    Daily,
    Weekly { weekday: Weekday },
    Monthly { day: u8 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveWindow {
    pub start: DateTime<Utc>,
    pub next_reset: DateTime<Utc>,
}

impl WindowKind {
    pub fn from_config(cfg: &WindowCfg) -> anyhow::Result<Self> {
        Ok(match cfg.r#type {
            WindowTypeCfg::Rolling => {
                let d = cfg.duration.as_deref()
                    .ok_or_else(|| anyhow::anyhow!("rolling window requires --duration"))?;
                let dur = parse_duration(d).map_err(|e| anyhow::anyhow!("bad duration '{d}': {e}"))?;
                WindowKind::Rolling { duration: helpers::chrono_duration_from_std(dur)? }
            }
            WindowTypeCfg::Daily => WindowKind::Daily,
            WindowTypeCfg::Weekly => {
                let w = cfg.duration.as_deref()
                    .ok_or_else(|| anyhow::anyhow!("weekly window requires weekday (e.g. mon)"))?;
                let wd = helpers::parse_weekday(w)
                    .ok_or_else(|| anyhow::anyhow!("invalid weekday: {w}"))?;
                WindowKind::Weekly { weekday: wd }
            }
            WindowTypeCfg::Monthly => {
                let d: u8 = cfg.duration.as_deref()
                    .ok_or_else(|| anyhow::anyhow!("monthly window requires --day"))?
                    .parse()
                    .map_err(|_| anyhow::anyhow!("invalid day: must be 1..=31"))?;
                if !(1..=31).contains(&d) {
                    anyhow::bail!("invalid day: must be 1..=31");
                }
                WindowKind::Monthly { day: d }
            }
        })
    }

    pub fn active_at(&self, now: DateTime<Utc>) -> ActiveWindow {
        match *self {
            WindowKind::Rolling { duration } => {
                let dur = duration.num_seconds().max(1);
                let grid = (now.timestamp() / dur) * dur;
                let start = Utc.timestamp_opt(grid, 0).single().unwrap_or(now);
                let next_reset = start + duration;
                ActiveWindow { start, next_reset }
            }
            WindowKind::Daily => {
                let d = now.date_naive();
                let start = d.and_hms_opt(0, 0, 0).unwrap().and_utc();
                let next_reset = start + Duration::days(1);
                ActiveWindow { start, next_reset }
            }
            WindowKind::Weekly { weekday } => {
                let start_date = helpers::most_recent_weekday_on_or_before(now.date_naive(), weekday);
                let start = start_date.and_hms_opt(0, 0, 0).unwrap().and_utc();
                let next_reset = start + Duration::days(7);
                ActiveWindow { start, next_reset }
            }
            WindowKind::Monthly { day } => {
                let (start_date, next_date) = helpers::monthly_window(now.date_naive(), day);
                let start = start_date.and_hms_opt(0, 0, 0).unwrap().and_utc();
                let next_reset = next_date.and_hms_opt(0, 0, 0).unwrap().and_utc();
                ActiveWindow { start, next_reset }
            }
        }
    }

    /// The window an event at time `t` belongs to.
    pub fn bucket_start(&self, t: DateTime<Utc>) -> DateTime<Utc> {
        self.active_at(t).start
    }
}
