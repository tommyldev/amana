import { test, expect } from "bun:test";
import { activeAt, bucketStart, windowFromConfig, type WindowKind } from "./window.ts";
import { parseDurationMs, parseWeekday } from "./duration.ts";

const utc = (y: number, m: number, d: number, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h, mi, 0);
const rolling5h: WindowKind = { type: "rolling", durationMs: 5 * 3_600_000 };

test("rolling window floors to the epoch grid", () => {
  const aw = activeAt(rolling5h, utc(2026, 6, 27, 12, 34));
  expect(aw.start).toBe(utc(2026, 6, 27, 11, 0));
  expect(aw.nextReset).toBe(utc(2026, 6, 27, 16, 0));
});

test("daily window is UTC midnight to midnight", () => {
  const aw = activeAt({ type: "daily" }, utc(2026, 6, 27, 12, 34));
  expect(aw.start).toBe(utc(2026, 6, 27, 0, 0));
  expect(aw.nextReset).toBe(utc(2026, 6, 28, 0, 0));
});

test("weekly window anchors on the target weekday", () => {
  // 2026-06-27 is a Saturday; target Mon => start 2026-06-22.
  const aw = activeAt({ type: "weekly", weekday: 0 }, utc(2026, 6, 27, 23, 0));
  expect(aw.start).toBe(utc(2026, 6, 22, 0, 0));
  expect(aw.nextReset).toBe(utc(2026, 6, 29, 0, 0));
});

test("monthly day-31 clamps within February", () => {
  const aw = activeAt({ type: "monthly", day: 31 }, utc(2026, 2, 15, 12, 0));
  expect(aw.start).toBe(utc(2026, 1, 31, 0, 0));
  expect(aw.nextReset).toBe(utc(2026, 2, 28, 0, 0));
});

test("monthly day-31 next reset clamps across months", () => {
  const aw = activeAt({ type: "monthly", day: 31 }, utc(2026, 3, 1, 12, 0));
  expect(aw.start).toBe(utc(2026, 2, 28, 0, 0));
  expect(aw.nextReset).toBe(utc(2026, 3, 31, 0, 0));
});

test("bucketStart of an in-window event equals the window start", () => {
  const now = utc(2026, 6, 27, 12, 34);
  const aw = activeAt(rolling5h, now);
  expect(bucketStart(rolling5h, aw.start + 10 * 60_000)).toBe(aw.start);
});

test("windowFromConfig parses each window type", () => {
  expect(windowFromConfig({ type: "rolling", duration: "5h" })).toEqual(rolling5h);
  expect(windowFromConfig({ type: "daily" })).toEqual({ type: "daily" });
  expect(windowFromConfig({ type: "weekly", duration: "mon" })).toEqual({ type: "weekly", weekday: 0 });
  expect(windowFromConfig({ type: "monthly", duration: "1" })).toEqual({ type: "monthly", day: 1 });
});

test("duration and weekday parsing", () => {
  expect(parseDurationMs("5h")).toBe(5 * 3_600_000);
  expect(parseDurationMs("1h30m")).toBe(90 * 60_000);
  expect(parseDurationMs("90s")).toBe(90_000);
  expect(parseWeekday("sunday")).toBe(6);
  expect(parseWeekday("nope")).toBeUndefined();
  expect(() => parseDurationMs("5x")).toThrow();
});
