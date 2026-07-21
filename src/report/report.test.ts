/**
 * renderReport renders one line PER CONFIGURED WINDOW, so a FiveHourWeekly
 * provider shows both its rolling-5h and its weekly line (each with that
 * window's own usage), while a single-window provider shows exactly one.
 */
import { describe, expect, test } from "bun:test";
import { openDb } from "../db/db.ts";
import { insertEvents } from "../db/usage.ts";
import type { Config, ProviderCfg } from "../config/types.ts";
import type { UsageEventRow } from "../db/types.ts";
import { renderReport } from "./report.ts";

// Wed 2026-01-14 12:30 UTC — mid 5h grid cell, week (mon anchor) began Jan 12.
const NOW = Date.UTC(2026, 0, 14, 12, 30, 0);

function ev(source: string, id: string, tsMs: number, total: number): UsageEventRow {
  return {
    source,
    source_message_id: id,
    timestamp_ms: tsMs,
    provider: source,
    model: "m",
    prompt_tokens: total,
    completion_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    total_tokens: total,
    cost_usd: 0,
    cost_origin: "logged",
  };
}

function provider(id: string, extraWeekly: boolean): ProviderCfg {
  return {
    id,
    enabled: true,
    auth_method: "none",
    usage_window: { type: "rolling", duration: "5h" },
    extra_windows: extraWeekly ? [{ type: "weekly", duration: "mon" }] : [],
    limits: {},
  };
}

function cfg(): Config {
  return {
    ui: { refresh_interval_seconds: 60 },
    alerts: { enabled: true, thresholds: [90], desktop: false },
    providers: [provider("claude-code", true), provider("omp", false)],
  };
}

function seed() {
  const db = openDb(":memory:");
  // claude-code: recent event in-window for both; older event only in the week.
  insertEvents(db, [
    ev("claude-code", "cc-recent", NOW - 5 * 60_000, 100),
    ev("claude-code", "cc-old", NOW - 12 * 3_600_000, 900),
    ev("omp", "omp-recent", NOW - 5 * 60_000, 50),
  ]);
  return db;
}

describe("renderReport multi-window", () => {
  const out = () => renderReport(seed(), cfg(), NOW);

  test("a FiveHourWeekly provider renders both its rolling and weekly line", () => {
    const lines = out().split("\n").filter((l) => l.startsWith("claude-code"));
    expect(lines).toHaveLength(2);
    expect(lines.some((l) => l.includes("[rolling 5h]"))).toBe(true);
    expect(lines.some((l) => l.includes("[weekly mon]"))).toBe(true);
  });

  test("a single-window provider renders exactly one line", () => {
    const lines = out().split("\n").filter((l) => l.startsWith("omp"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[rolling 5h]");
  });

  test("each window shows its OWN usage total (weekly > rolling)", () => {
    const lines = out().split("\n");
    const rolling = lines.find((l) => l.startsWith("claude-code") && l.includes("[rolling 5h]"))!;
    const weekly = lines.find((l) => l.startsWith("claude-code") && l.includes("[weekly mon]"))!;
    expect(rolling).toContain("100 tok"); // only the recent event
    expect(weekly).toContain("1.0k tok"); // recent + older, summed
  });
});

describe("renderReport bar visibility", () => {
  test("a limitless window shows no percent or bar, only usage", () => {
    const line = renderReport(seed(), cfg(), NOW)
      .split("\n")
      .find((l) => l.startsWith("omp"))!;
    expect(line).not.toContain("%");
    expect(line).not.toContain("░");
    expect(line).not.toContain("█");
    expect(line).toContain("50 tok");
  });

  test("a token-limited window shows the bar and percent", () => {
    const limited: Config = {
      ui: { refresh_interval_seconds: 60 },
      alerts: { enabled: true, thresholds: [90], desktop: false },
      providers: [{ ...provider("omp", false), limits: { window_token_limit: 100 } }],
    };
    const line = renderReport(seed(), limited, NOW)
      .split("\n")
      .find((l) => l.startsWith("omp"))!;
    expect(line).toContain("%");
    expect(line).toContain("█");
    expect(line).toContain("50 / 100 tok");
  });
});

describe("renderReport monthly cost cap", () => {
  test("per-window cost is the window's own; a separate monthly cost line shows spend vs cap", () => {
    const db = openDb(":memory:");
    insertEvents(db, [
      { source: "omp", source_message_id: "recent", timestamp_ms: NOW - 5 * 60_000, provider: "omp", model: "m", prompt_tokens: 100, completion_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 100, cost_usd: 5, cost_origin: "logged" },
      { source: "omp", source_message_id: "old", timestamp_ms: NOW - 12 * 3_600_000, provider: "omp", model: "m", prompt_tokens: 100, completion_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 100, cost_usd: 3, cost_origin: "logged" },
    ]);
    const cfg: Config = {
      ui: { refresh_interval_seconds: 60 },
      alerts: { enabled: true, thresholds: [90], desktop: false },
      providers: [{ ...provider("omp", false), limits: { monthly_cost: 20 } }],
    };
    const lines = renderReport(db, cfg, NOW).split("\n");
    const windowLine = lines.find((l) => l.startsWith("omp") && l.includes("[rolling 5h]"))!;
    expect(windowLine).not.toContain("/ $20"); // monthly cap NOT smeared per-window
    expect(windowLine).toContain("$5.00"); // this window's own cost (recent only)
    const costLine = lines.find((l) => l.includes("[monthly cost]"))!;
    expect(costLine).toContain("$8.00 / $20.00"); // month spend = recent + old
  });
});
