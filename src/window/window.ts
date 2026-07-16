import type { WindowCfg } from "../config/types.ts";
import { parseDurationMs, parseWeekday } from "./duration.ts";

export type WindowKind =
  | { type: "rolling"; durationMs: number }
  | { type: "daily" }
  | { type: "weekly"; weekday: number }
  | { type: "monthly"; day: number };

export interface ActiveWindow {
  start: number;
  nextReset: number;
}

const DAY_MS = 86_400_000;

export function windowFromConfig(cfg: WindowCfg): WindowKind {
  switch (cfg.type) {
    case "rolling": {
      if (cfg.duration === undefined) throw new Error("rolling window requires a duration");
      return { type: "rolling", durationMs: parseDurationMs(cfg.duration) };
    }
    case "daily":
      return { type: "daily" };
    case "weekly": {
      if (cfg.duration === undefined) throw new Error("weekly window requires a weekday (e.g. mon)");
      const weekday = parseWeekday(cfg.duration);
      if (weekday === undefined) throw new Error(`invalid weekday: ${cfg.duration}`);
      return { type: "weekly", weekday };
    }
    case "monthly": {
      if (cfg.duration === undefined) throw new Error("monthly window requires a day");
      const day = Number(cfg.duration);
      if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error("invalid day: must be 1..=31");
      return { type: "monthly", day };
    }
  }
}

function startOfUtcDay(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Monday-indexed weekday (Mon=0..Sun=6) of a UTC timestamp. */
function mondayIndex(ms: number): number {
  return (new Date(ms).getUTCDay() + 6) % 7;
}

function lastDayOfMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

function clampDay(year: number, month1: number, day: number): number {
  const dd = Math.min(day, lastDayOfMonth(year, month1));
  return Date.UTC(year, month1 - 1, dd);
}

export function activeAt(kind: WindowKind, nowMs: number): ActiveWindow {
  switch (kind.type) {
    case "rolling": {
      const durSec = Math.max(Math.floor(kind.durationMs / 1000), 1);
      const nowSec = Math.floor(nowMs / 1000);
      const grid = Math.floor(nowSec / durSec) * durSec;
      const start = grid * 1000;
      return { start, nextReset: start + kind.durationMs };
    }
    case "daily": {
      const start = startOfUtcDay(nowMs);
      return { start, nextReset: start + DAY_MS };
    }
    case "weekly": {
      const today = startOfUtcDay(nowMs);
      const diff = (mondayIndex(today) - kind.weekday + 7) % 7;
      const start = today - diff * DAY_MS;
      return { start, nextReset: start + 7 * DAY_MS };
    }
    case "monthly": {
      const d = new Date(nowMs);
      const y = d.getUTCFullYear();
      const m1 = d.getUTCMonth() + 1;
      const today = startOfUtcDay(nowMs);
      const candThis = clampDay(y, m1, kind.day);
      if (candThis <= today) {
        const [ny, nm] = m1 === 12 ? [y + 1, 1] : [y, m1 + 1];
        return { start: candThis, nextReset: clampDay(ny, nm, kind.day) };
      }
      const [py, pm] = m1 === 1 ? [y - 1, 12] : [y, m1 - 1];
      return { start: clampDay(py, pm, kind.day), nextReset: candThis };
    }
  }
}

/** The start of the window an event at time `t` belongs to. */
export function bucketStart(kind: WindowKind, tMs: number): number {
  return activeAt(kind, tMs).start;
}
