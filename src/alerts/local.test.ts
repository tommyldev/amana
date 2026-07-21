/**
 * localAlertReports turns configured local token caps into synthetic usage
 * reports so `checkAndFire` warns on local providers — the advertised
 * `amana limit set` + alerts path, which previously never fired without a login.
 */
import { describe, expect, test } from "bun:test";
import { openDb } from "../db/db.ts";
import { insertEvents } from "../db/usage.ts";
import { buildSnapshot } from "../report/snapshot.ts";
import { checkAndFire } from "./engine.ts";
import { localAlertReports } from "./local.ts";
import type { Config, ProviderCfg } from "../config/types.ts";
import type { UsageEventRow } from "../db/types.ts";

const NOW = Date.UTC(2026, 0, 14, 12, 30, 0);
const ALERTS = { enabled: true, thresholds: [75, 90, 100], desktop: false };

function ev(total: number): UsageEventRow {
  return {
    source: "claude-code",
    source_message_id: `m-${total}-${Math.random()}`,
    timestamp_ms: NOW - 5 * 60_000,
    provider: "claude-code",
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

function provider(id: string, tokenLimit?: number): ProviderCfg {
  return {
    id,
    enabled: true,
    auth_method: "none",
    usage_window: { type: "rolling", duration: "5h" },
    extra_windows: [],
    limits: tokenLimit === undefined ? {} : { window_token_limit: tokenLimit },
  };
}

function setup(used: number, tokenLimit?: number, providers?: ProviderCfg[]) {
  const db = openDb(":memory:");
  if (used > 0) insertEvents(db, [ev(used)]);
  const cfg: Config = {
    ui: { refresh_interval_seconds: 60 },
    alerts: ALERTS,
    providers: providers ?? [provider("claude-code", tokenLimit)],
  };
  return { db, cfg, snap: buildSnapshot(db, cfg, NOW) };
}

describe("localAlertReports", () => {
  test("builds a synthetic report with the correct usedFraction and reset", () => {
    const { cfg, snap } = setup(920, 1000);
    const reports = localAlertReports(cfg, snap, new Set());
    expect(reports).toHaveLength(1);
    const limit = reports[0]!.limits[0]!;
    expect(limit.amount.usedFraction).toBeCloseTo(0.92, 5);
    expect(limit.window?.resetsAt).toBe(snap.providers[0]!.windows[0]!.active!.nextReset);
  });

  test("no report for a provider without a configured token limit", () => {
    const { cfg, snap } = setup(920);
    expect(localAlertReports(cfg, snap, new Set())).toHaveLength(0);
  });

  test("excludes a provider that already has a live report this cycle", () => {
    const { cfg, snap } = setup(920, 1000);
    expect(localAlertReports(cfg, snap, new Set(["claude-code"]))).toHaveLength(0);
  });
});

describe("checkAndFire on local reports", () => {
  test("fires once when a local cap is crossed, then dedups", () => {
    const { db, cfg, snap } = setup(920, 1000);
    const reports = localAlertReports(cfg, snap, new Set());
    const first = checkAndFire(db, cfg.alerts, reports);
    expect(first).toHaveLength(1);
    expect(first[0]!.threshold).toBe(90);
    expect(first[0]!.provider).toBe("claude-code");
    expect(checkAndFire(db, cfg.alerts, reports)).toHaveLength(0);
  });

  test("does not fire below the lowest threshold", () => {
    const { db, cfg, snap } = setup(500, 1000);
    const reports = localAlertReports(cfg, snap, new Set());
    expect(checkAndFire(db, cfg.alerts, reports)).toHaveLength(0);
  });
});

describe("localAlertReports cost cap", () => {
  function costEv(total: number, cost: number): UsageEventRow {
    return {
      source: "claude-code", source_message_id: `c-${total}-${cost}-${Math.random()}`,
      timestamp_ms: NOW - 5 * 60_000, provider: "claude-code", model: "m",
      prompt_tokens: total, completion_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
      total_tokens: total, cost_usd: cost, cost_origin: "logged",
    };
  }
  function withCostCap(events: UsageEventRow[], limits: { window_token_limit?: number; monthly_cost?: number }) {
    const db = openDb(":memory:");
    insertEvents(db, events);
    const cfg: Config = {
      ui: { refresh_interval_seconds: 60 }, alerts: ALERTS,
      providers: [{ ...provider("claude-code"), limits }],
    };
    return { db, cfg, snap: buildSnapshot(db, cfg, NOW) };
  }

  test("emits a cost-cap limit and fires when spend crosses a threshold", () => {
    const { db, cfg, snap } = withCostCap([costEv(100, 9)], { monthly_cost: 10 });
    const reports = localAlertReports(cfg, snap, new Set());
    const costLimit = reports[0]!.limits.find((l) => l.id === "local-cost-cap")!;
    expect(costLimit.amount.usedFraction).toBeCloseTo(0.9, 5);
    const fired = checkAndFire(db, cfg.alerts, reports);
    expect(fired.some((f) => f.limitId === "local-cost-cap" && f.threshold === 90)).toBe(true);
  });

  test("emits both token and cost limits when both caps are set", () => {
    const { cfg, snap } = withCostCap([costEv(500, 5)], { window_token_limit: 1000, monthly_cost: 10 });
    const ids = localAlertReports(cfg, snap, new Set())[0]!.limits.map((l) => l.id).sort();
    expect(ids).toEqual(["local-cost-cap", "local-token-budget"]);
  });

  test("does not fire when spend is below the lowest threshold", () => {
    const { db, cfg, snap } = withCostCap([costEv(100, 5)], { monthly_cost: 10 });
    const fired = checkAndFire(db, cfg.alerts, localAlertReports(cfg, snap, new Set()));
    expect(fired.some((f) => f.limitId === "local-cost-cap")).toBe(false);
  });
});
