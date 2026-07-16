use chrono::{Datelike, Duration, NaiveDate, Weekday};

pub(super) fn chrono_duration_from_std(d: std::time::Duration) -> anyhow::Result<Duration> {
    Duration::from_std(d).map_err(|_| anyhow::anyhow!("duration out of range"))
}

pub(super) fn parse_weekday(s: &str) -> Option<Weekday> {
    Some(match s.to_ascii_lowercase().as_str() {
        "mon" | "monday" => Weekday::Mon,
        "tue" | "tues" | "tuesday" => Weekday::Tue,
        "wed" | "wednesday" => Weekday::Wed,
        "thu" | "thur" | "thurs" | "thursday" => Weekday::Thu,
        "fri" | "friday" => Weekday::Fri,
        "sat" | "saturday" => Weekday::Sat,
        "sun" | "sunday" => Weekday::Sun,
        _ => return None,
    })
}

pub(super) fn most_recent_weekday_on_or_before(d: NaiveDate, target: Weekday) -> NaiveDate {
    let current = d.week(Weekday::Mon).first_day();
    let cur_wd = current.weekday();
    let diff = (cur_wd.num_days_from_monday() as i64 - target.num_days_from_monday() as i64).rem_euclid(7);
    let candidate = current + Duration::days(-diff);
    if candidate <= d { candidate } else { candidate - Duration::days(7) }
}

pub(super) fn monthly_window(today: NaiveDate, day: u8) -> (NaiveDate, NaiveDate) {
    let candidate_this_month = clamp_day(today.year(), today.month(), day);
    if candidate_this_month <= today {
        let (ny, nm) = if today.month() == 12 { (today.year() + 1, 1) } else { (today.year(), today.month() + 1) };
        let next = clamp_day(ny, nm, day);
        (candidate_this_month, next)
    } else {
        let (py, pm) = if today.month() == 1 { (today.year() - 1, 12) } else { (today.year(), today.month() - 1) };
        let prev = clamp_day(py, pm, day);
        (prev, candidate_this_month)
    }
}

fn clamp_day(year: i32, month: u32, day: u8) -> NaiveDate {
    let last = last_day_of_month(year, month);
    let d = (day as u32).min(last);
    NaiveDate::from_ymd_opt(year, month, d).unwrap()
}

fn last_day_of_month(year: i32, month: u32) -> u32 {
    let (ny, nm) = if month == 12 { (year + 1, 1) } else { (year, month + 1) };
    let first_next = NaiveDate::from_ymd_opt(ny, nm, 1).unwrap();
    (first_next - Duration::days(1)).day()
}
