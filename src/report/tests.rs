use super::format::*;

#[test]
fn fmt_tokens_works() {
    assert_eq!(fmt_tokens(0), "0");
    assert_eq!(fmt_tokens(999), "999");
    assert_eq!(fmt_tokens(1500), "1.5k");
    assert_eq!(fmt_tokens(1_500_000), "1.5M");
}

#[test]
fn fmt_duration_works() {
    assert_eq!(fmt_duration(0), "now");
    assert_eq!(fmt_duration(30), "0m");
    assert_eq!(fmt_duration(125), "2m");
    assert_eq!(fmt_duration(3700), "1h 01m");
    assert_eq!(fmt_duration(90000), "1d 01h");
}

#[test]
fn bar_clamps() {
    assert_eq!(bar(0.0).chars().count(), 10);
    assert_eq!(bar(100.0).chars().count(), 10);
    assert!(bar(50.0).contains('█'));
}
