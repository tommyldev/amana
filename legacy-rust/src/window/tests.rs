use super::*;
use chrono::TimeZone;

fn utc(y: i32, m: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(y, m, d, h, mi, 0).unwrap()
}

#[test]
fn rolling_floor_5h() {
    // 5h = 18000s. Epoch-grid floor (not wall-clock 0/5/10/...).
    // For 2026-06-27 12:34:00 UTC, floor lands at 11:00:00 UTC.
    let w = WindowKind::Rolling { duration: Duration::hours(5) };
    let aw = w.active_at(utc(2026, 6, 27, 12, 34));
    assert_eq!(aw.start, utc(2026, 6, 27, 11, 0));
    assert_eq!(aw.next_reset, utc(2026, 6, 27, 16, 0));
}

#[test]
fn daily_window() {
    let w = WindowKind::Daily;
    let aw = w.active_at(utc(2026, 6, 27, 12, 34));
    assert_eq!(aw.start, utc(2026, 6, 27, 0, 0));
    assert_eq!(aw.next_reset, utc(2026, 6, 28, 0, 0));
}

#[test]
fn weekly_wrap() {
    // 2026-06-27 is a Saturday. With target Mon, start = 2026-06-22.
    let w = WindowKind::Weekly { weekday: Weekday::Mon };
    let aw = w.active_at(utc(2026, 6, 27, 23, 0));
    assert_eq!(aw.start, utc(2026, 6, 22, 0, 0));
    assert_eq!(aw.next_reset, utc(2026, 6, 29, 0, 0));
}

#[test]
fn monthly_day31_in_feb_clamps() {
    // Pretend today is Feb 15, 2026. Day=31 → clamp to Feb 28.
    let w = WindowKind::Monthly { day: 31 };
    let aw = w.active_at(utc(2026, 2, 15, 12, 0));
    // Start is the most recent day-31 (clamped) on or before today.
    // Jan 31 < Feb 15, so start = Jan 31.
    assert_eq!(aw.start, utc(2026, 1, 31, 0, 0));
    // Next reset = Feb 28 (clamped).
    assert_eq!(aw.next_reset, utc(2026, 2, 28, 0, 0));
}

#[test]
fn monthly_day31_next_month_clamp() {
    // After Feb 28, next_reset is in March at day-31 → March 31.
    let w = WindowKind::Monthly { day: 31 };
    let aw = w.active_at(utc(2026, 3, 1, 12, 0));
    // Start = Feb 28 (clamped) < Mar 1, so start is the previous clamped bucket.
    assert_eq!(aw.start, utc(2026, 2, 28, 0, 0));
    // Next = Mar 31.
    assert_eq!(aw.next_reset, utc(2026, 3, 31, 0, 0));
}

#[test]
fn bucket_start_membership() {
    // For an event timestamp inside a window, bucket_start == window.start.
    let w = WindowKind::Rolling { duration: Duration::hours(5) };
    let now = utc(2026, 6, 27, 12, 34);
    let aw = w.active_at(now);
    let t = aw.start + Duration::minutes(10);
    assert_eq!(w.bucket_start(t), aw.start);
}
