import type { Config } from "../config/types.ts";
import type { Snapshot } from "../report/snapshot.ts";
import { statusOf, type UsageLimit, type UsageReport } from "../usage/types.ts";
import { activeAt } from "../window/window.ts";

/**
 * Synthetic usage reports for LOCAL providers so threshold alerts fire on
 * configured caps just like live quota. One report per enabled provider (with no
 * live report this cycle) carrying a limit for each configured cap:
 *   - a `window_token_limit` (fraction from the primary window's usage), and/or
 *   - a `monthly_cost` cap (fraction from this month's spend, `monthCostUsed`).
 * Each limit's `usedFraction` + `window.resetsAt` come from the snapshot, so
 * `checkAndFire` dedups per reset exactly as it does for live limits.
 */
export function localAlertReports(
  cfg: Config,
  snap: Snapshot,
  liveProviders: Set<string>,
): UsageReport[] {
  const out: UsageReport[] = [];
  for (let i = 0; i < cfg.providers.length; i++) {
    const prov = cfg.providers[i]!;
    if (!prov.enabled || liveProviders.has(prov.id)) continue;
    const view = snap.providers[i]!;
    const limits: UsageLimit[] = [];

    const tokenLimit = prov.limits.window_token_limit;
    const w = view.windows[0];
    if (tokenLimit !== undefined && tokenLimit > 0 && w?.active) {
      const frac = w.usage.total / tokenLimit;
      limits.push({
        id: "local-token-budget",
        label: `token budget · ${w.desc}`,
        scope: { provider: prov.id, shared: false },
        window: { id: "local", label: w.desc, resetsAt: w.active.nextReset },
        amount: { used: w.usage.total, limit: tokenLimit, usedFraction: frac, unit: "tokens" },
        status: statusOf(frac),
        notes: [],
      });
    }

    const costCap = prov.limits.monthly_cost;
    if (costCap !== undefined && costCap > 0) {
      const used = view.monthCostUsed ?? 0;
      const frac = used / costCap;
      const month = activeAt({ type: "monthly", day: 1 }, snap.now);
      limits.push({
        id: "local-cost-cap",
        label: "monthly cost cap",
        scope: { provider: prov.id, shared: false },
        window: { id: "local-month", label: "monthly", resetsAt: month.nextReset },
        amount: { used, limit: costCap, usedFraction: frac, unit: "usd" },
        status: statusOf(frac),
        notes: [],
      });
    }

    if (limits.length > 0) {
      out.push({ provider: prov.id, account: "local", fetchedAt: snap.now, limits, notes: [] });
    }
  }
  return out;
}
