/**
 * The provider drill-in surfaces per-window usage for LOCAL providers (no live
 * login), reusing the shared limitRows — previously it showed only a chart +
 * model table with no window summary.
 */
import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { openDb } from "../../db/db.ts";
import { insertEvents } from "../../db/usage.ts";
import { buildSnapshot } from "../../report/snapshot.ts";
import { buildLimitRows } from "./limitRows.ts";
import { ProviderView } from "./ProviderView.tsx";
import { initialState } from "../state.ts";
import type { Config, ProviderCfg } from "../../config/types.ts";
import type { UsageEventRow } from "../../db/types.ts";

const NOW = Date.now();
const alerts = { enabled: true, thresholds: [75, 90, 100], desktop: true };

function ev(total: number, costUsd = 0): UsageEventRow {
  return {
    source: "claude-code", source_message_id: `m-${total}-${costUsd}`, timestamp_ms: NOW - 60_000,
    provider: "claude-code", model: "sonnet", prompt_tokens: total, completion_tokens: 0,
    cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: total, cost_usd: costUsd, cost_origin: "logged",
  };
}

function claudeCode(tokenLimit?: number): ProviderCfg {
  return {
    id: "claude-code", enabled: true, auth_method: "none",
    usage_window: { type: "rolling", duration: "5h" },
    extra_windows: [{ type: "weekly", duration: "mon" }],
    limits: tokenLimit === undefined ? {} : { window_token_limit: tokenLimit },
  };
}

function frameFor(tokenLimit?: number): string {
  const db = openDb(":memory:");
  insertEvents(db, [ev(4000)]);
  const cfg: Config = { ui: { refresh_interval_seconds: 60 }, alerts, providers: [claudeCode(tokenLimit)] };
  const limitRows = buildLimitRows(cfg, [], [], buildSnapshot(db, cfg, NOW));
  const state = { ...initialState(alerts), drillProvider: "claude-code", limitRows };
  return render(<ProviderView state={state} db={db} />).lastFrame() ?? "";
}

function frameWithCost(costUsd: number): string {
  const db = openDb(":memory:");
  insertEvents(db, [ev(4000, costUsd)]);
  const cfg: Config = { ui: { refresh_interval_seconds: 60 }, alerts, providers: [claudeCode()] };
  const state = { ...initialState(alerts), drillProvider: "claude-code", limitRows: [] };
  return render(<ProviderView state={state} db={db} />).lastFrame() ?? "";
}

describe("ProviderView local drill-in", () => {
  test("renders per-window usage rows for a local provider", () => {
    const frame = frameFor();
    expect(frame).toContain("usage · rolling 5h");
    expect(frame).toContain("usage · weekly mon");
    expect(frame).toContain("4.0k tok");
  });

  test("shows a token budget gauge line when a limit is configured", () => {
    const frame = frameFor(10_000);
    expect(frame).toContain("token budget · rolling 5h");
    expect(frame).toContain("4.0k / 10.0k tok");
  });
});

describe("ProviderView total cost", () => {
  test("shows total est $ in header when cost is non-zero", () => {
    expect(frameWithCost(2.5)).toContain("$2.50");
  });

  test("omits cost when total is zero", () => {
    const frame = frameWithCost(0);
    const header = frame.split("\n")[0] ?? "";
    expect(header).not.toContain("$");
  });
});