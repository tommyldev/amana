/**
 * buildLimitRows emits one local usage row PER CONFIGURED WINDOW (primary +
 * extras), each reflecting that window's own usage — so a FiveHourWeekly
 * provider yields two usage rows, a single-window provider one.
 */
import { describe, expect, test } from "bun:test";
import { openDb } from "../../db/db.ts";
import { insertEvents } from "../../db/usage.ts";
import { buildSnapshot } from "../../report/snapshot.ts";
import type { Config, ProviderCfg } from "../../config/types.ts";
import type { UsageEventRow } from "../../db/types.ts";
import { buildLimitRows } from "./limitRows.ts";

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

function setup() {
  const db = openDb(":memory:");
  insertEvents(db, [
    ev("claude-code", "cc-recent", NOW - 5 * 60_000, 100),
    ev("claude-code", "cc-old", NOW - 12 * 3_600_000, 900),
    ev("omp", "omp-recent", NOW - 5 * 60_000, 50),
  ]);
  const cfg: Config = {
    ui: { refresh_interval_seconds: 60 },
    alerts: { enabled: true, thresholds: [90], desktop: false },
    providers: [provider("claude-code", true), provider("omp", false)],
  };
  const snap = buildSnapshot(db, cfg, NOW);
  return buildLimitRows(cfg, [], [], snap);
}

describe("buildLimitRows local windows", () => {
  const usageRows = (provider: string) =>
    setup().filter((r) => r.provider === provider && r.limitLabel.startsWith("usage · "));

  test("a FiveHourWeekly provider yields one usage row per window", () => {
    const rows = usageRows("claude-code");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.limitLabel)).toEqual(["usage · rolling 5h", "usage · weekly mon"]);
  });

  test("a single-window provider yields one usage row", () => {
    expect(usageRows("omp")).toHaveLength(1);
  });

  test("each window row reflects its own usage total", () => {
    const rows = usageRows("claude-code");
    const rolling = rows.find((r) => r.limitLabel.includes("rolling"))!;
    const weekly = rows.find((r) => r.limitLabel.includes("weekly"))!;
    expect(rolling.detail).toContain("100 tok");
    expect(weekly.detail).toContain("1.0k tok");
    expect(rolling.detail).not.toEqual(weekly.detail);
  });

  test("local window rows carry a reset from their own window", () => {
    for (const r of usageRows("claude-code")) {
      expect(typeof r.resetsAt).toBe("number");
      expect(r.resetsAt!).toBeGreaterThan(NOW);
    }
  });
});

describe("buildLimitRows monthly cost cap", () => {
  test("shows spend vs cap with a gauge", () => {
    const db = openDb(":memory:");
    const costEvent: UsageEventRow = {
      source: "omp", source_message_id: "c1", timestamp_ms: NOW - 5 * 60_000,
      provider: "omp", model: "m", prompt_tokens: 100, completion_tokens: 0,
      cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 100,
      cost_usd: 6, cost_origin: "logged",
    };
    insertEvents(db, [costEvent]);
    const cfg: Config = {
      ui: { refresh_interval_seconds: 60 },
      alerts: { enabled: true, thresholds: [90], desktop: false },
      providers: [{ ...provider("omp", false), limits: { monthly_cost: 10 } }],
    };
    const snap = buildSnapshot(db, cfg, NOW);
    expect(snap.providers[0]!.monthCostUsed).toBeCloseTo(6, 5);
    const cap = buildLimitRows(cfg, [], [], snap).find((r) => r.limitLabel === "monthly cost cap")!;
    expect(cap.gauge).toBe(true);
    expect(cap.detail).toBe("$6.00 / $10.00");
    expect(cap.pct).toBeCloseTo(60, 5);
  });
});
