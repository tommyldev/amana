import type { Database } from "bun:sqlite";
import type { Config, ProviderCfg, WindowCfg } from "../config/types.ts";
import type { UsageAggregate } from "../db/types.ts";
import type { ActiveWindow } from "../window/window.ts";
import { activeAt, windowFromConfig } from "../window/window.ts";
import { todaysTotals, windowUsage } from "../db/usage.ts";
import { providerStatus } from "../db/providers.ts";
import { byId } from "../registry.ts";
import { pctOf } from "./format.ts";

/** One reset window for a provider (a provider may track several at once). */
export interface WindowView {
  desc: string;
  active?: ActiveWindow;
  usage: UsageAggregate;
  tokenLimit?: number;
  pct: number;
  error?: string;
}

/** One provider's resolved state at a moment in time; shared by CLI + TUI. */
export interface ProviderView {
  id: string;
  label: string;
  enabled: boolean;
  status: string;
  windows: WindowView[];
  monthlyCostLimit?: number;
  monthCostUsed?: number;
}

export interface Snapshot {
  now: number;
  today: UsageAggregate;
  providers: ProviderView[];
}

const EMPTY_AGG: UsageAggregate = { requests: 0, prompt: 0, completion: 0, total: 0, cost: 0 };

/** The primary (first) window of a provider view. */
export function primary(view: ProviderView): WindowView {
  return view.windows[0]!;
}

/** Window whose reset is nearest in the future; falls back to primary. */
export function soonest(view: ProviderView): WindowView {
  let best: WindowView | undefined;
  for (const w of view.windows) {
    if (!w.active) continue;
    if (!best || w.active.nextReset < best.active!.nextReset) best = w;
  }
  return best ?? view.windows[0]!;
}

/** DB source names an event for `providerId` is stored under. */
export function sourcesFor(providerId: string): string[] {
  const def = byId(providerId);
  if (!def) return [providerId];
  switch (def.sourceKind) {
    case "LogOmp":
      return ["omp"];
    case "LogClaudeCode":
      return ["claude-code"];
    case "AdminOpenAI":
      return ["openai-api"];
    case "AdminAnthropic":
      return ["anthropic-api"];
  }
}

function describeWindowCfg(cfg: WindowCfg): string {
  switch (cfg.type) {
    case "rolling":
      return `rolling ${cfg.duration ?? "5h"}`;
    case "daily":
      return "daily";
    case "weekly":
      return `weekly ${cfg.duration ?? "mon"}`;
    case "monthly":
      return `monthly ${cfg.duration ?? "1"}`;
  }
}

function buildView(db: Database, prov: ProviderCfg, nowMs: number): ProviderView {
  const status = providerStatus(db, prov.id) ?? "ok";
  const sources = sourcesFor(prov.id);
  const ompProvider = byId(prov.id)?.ompProvider ?? undefined;
  const cfgs = [prov.usage_window, ...prov.extra_windows];
  const windows: WindowView[] = cfgs.map((cfg, i) => {
    const desc = describeWindowCfg(cfg);
    try {
      const kind = windowFromConfig(cfg);
      const aw = activeAt(kind, nowMs);
      const usage = windowUsage(db, aw.start, aw.nextReset, sources, ompProvider);
      const tokenLimit = i === 0 ? prov.limits.window_token_limit : undefined;
      return { desc, active: aw, usage, tokenLimit, pct: pctOf(usage.total, tokenLimit) };
    } catch (e) {
      return {
        desc,
        usage: { ...EMPTY_AGG },
        pct: 0,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  });
  const monthlyCostLimit = prov.limits.monthly_cost;
  let monthCostUsed: number | undefined;
  if (monthlyCostLimit !== undefined) {
    // Cost caps bill by calendar month; spend = this month's cost for the
    // provider's own sources, independent of its token usage window.
    const m = activeAt({ type: "monthly", day: 1 }, nowMs);
    monthCostUsed = windowUsage(db, m.start, m.nextReset, sources, ompProvider).cost;
  }
  return {
    id: prov.id,
    label: byId(prov.id)?.label ?? prov.id,
    enabled: prov.enabled,
    status,
    windows,
    monthlyCostLimit,
    monthCostUsed,
  };
}

export function buildSnapshot(db: Database, cfg: Config, nowMs: number): Snapshot {
  return {
    now: nowMs,
    today: todaysTotals(db, nowMs),
    providers: cfg.providers.map((prov) => buildView(db, prov, nowMs)),
  };
}
