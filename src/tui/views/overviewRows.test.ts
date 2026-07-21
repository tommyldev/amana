/**
 * buildOverviewRows marks a row `gauge:true` only when its pct reflects a REAL
 * limit (live quota or a configured token cap). A limitless provider's pct is
 * share-of-span-total, which must NOT render as a status-colored utilization
 * bar (a sole active provider would show a false red "exhausted" gauge).
 */
import { describe, expect, test } from "bun:test";
import { buildOverviewRows } from "./derive.ts";
import { makeLimit, makeReport } from "../../alerts/_factories.ts";
import type { Config, ProviderCfg } from "../../config/types.ts";

const alerts = { enabled: true, thresholds: [90], desktop: false };

function provider(id: string, tokenLimit?: number): ProviderCfg {
  return {
    id, enabled: true, auth_method: "none",
    usage_window: { type: "rolling", duration: "5h" },
    extra_windows: [],
    limits: tokenLimit === undefined ? {} : { window_token_limit: tokenLimit },
  };
}

function cfg(providers: ProviderCfg[]): Config {
  return { ui: { refresh_interval_seconds: 60 }, alerts, providers };
}

describe("buildOverviewRows gauge flag", () => {
  test("limitless provider: no gauge, share stated in text", () => {
    const totals = new Map([["omp", 1000], ["claude-code", 3000]]);
    const rows = buildOverviewRows(cfg([provider("omp"), provider("claude-code")]), [], [], totals, "24h");
    const omp = rows.find((r) => r.provider === "omp")!;
    expect(omp.gauge).toBe(false);
    expect(omp.pct).toBeCloseTo(25, 5); // 1000 / 4000
    expect(omp.detail).toContain("25% of 24h");
  });

  test("configured token cap: gauge on, utilization pct", () => {
    const totals = new Map([["omp", 3000]]);
    const rows = buildOverviewRows(cfg([provider("omp", 5000)]), [], [], totals, "24h");
    const omp = rows.find((r) => r.provider === "omp")!;
    expect(omp.gauge).toBe(true);
    expect(omp.pct).toBeCloseTo(60, 5); // 3000 / 5000
    expect(omp.detail).toContain("/ 5.0k tok");
  });

  test("live quota: gauge on", () => {
    const report = makeReport([makeLimit({ id: "5h", label: "5h", usedFraction: 0.5 })], "acct");
    const rows = buildOverviewRows(cfg([provider("anthropic")]), [report], [], new Map(), "24h");
    const row = rows.find((r) => r.provider === "anthropic")!;
    expect(row.live).toBe(true);
    expect(row.gauge).toBe(true);
  });

  test("error row: no gauge", () => {
    const errors = [{ provider: "omp", account: "local", message: "boom" }];
    const rows = buildOverviewRows(cfg([provider("omp")]), [], errors, new Map(), "24h");
    const omp = rows.find((r) => r.provider === "omp")!;
    expect(omp.gauge).toBe(false);
    expect(omp.error).toBe("boom");
  });
});
