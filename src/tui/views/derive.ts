import type { Config } from "../../config/types.ts";
import {
  resolveUsedFraction,
  statusOf,
  type UsageLimit,
  type UsageReport,
  type UsageStatus,
} from "../../usage/types.ts";
import type { FetchError } from "../../usage/orchestrator.ts";
import { fmtTokens } from "../../report/format.ts";
import { byId } from "../../registry.ts";

/** Percent (0..100) of a limit consumed; 0 when nothing usable is reported. */
export function limitPct(l: UsageLimit): number {
  return (resolveUsedFraction(l) ?? 0) * 100;
}

/** One provider's headline usage for the Overview list. */
export interface OverviewRow {
  provider: string;
  label: string;
  pct: number;
  status: UsageStatus;
  detail: string;
  resetsAt?: number;
  live: boolean;
  gauge: boolean;
  error?: string;
}

/** Most-pressured live limit across a provider's accounts. */
function peakLiveLimit(reports: UsageReport[]): { limit: UsageLimit; frac: number } | undefined {
  let best: { limit: UsageLimit; frac: number } | undefined;
  for (const r of reports) {
    for (const l of r.limits) {
      const frac = resolveUsedFraction(l);
      if (frac !== undefined && (best === undefined || frac > best.frac)) best = { limit: l, frac };
    }
  }
  return best;
}

/**
 * One Overview row per enabled provider. Prefers the most-pressured live limit
 * (from `amana login`); otherwise shows that provider's token usage over the
 * selected span (source-scoped totals in `spanTotals`), with the gauge as its
 * share of total span usage (or of its token limit when configured). Sorted by
 * pressure/usage desc, error rows last.
 */
export function buildOverviewRows(
  cfg: Config,
  reports: UsageReport[],
  errors: FetchError[],
  spanTotals: Map<string, number>,
  spanLabel: string,
): OverviewRow[] {
  const rows: OverviewRow[] = [];
  let grandTotal = 0;
  for (const t of spanTotals.values()) grandTotal += t;
  for (const prov of cfg.providers) {
    if (!prov.enabled) continue;
    const label = byId(prov.id)?.label ?? prov.id;
    const live = peakLiveLimit(reports.filter((r) => r.provider === prov.id));
    if (live) {
      rows.push({
        provider: prov.id,
        label,
        pct: live.frac * 100,
        status: statusOf(live.frac),
        detail: `${(live.frac * 100).toFixed(0)}% used`,
        resetsAt: live.limit.window?.resetsAt,
        live: true,
        gauge: true,
      });
      continue;
    }
    const err = errors.find((e) => e.provider === prov.id);
    if (err) {
      rows.push({ provider: prov.id, label, pct: 0, status: "unknown", detail: err.message, live: false, gauge: false, error: err.message });
      continue;
    }
    const used = spanTotals.get(prov.id) ?? 0;
    const tokenLimit = prov.limits.window_token_limit;
    if (tokenLimit !== undefined && tokenLimit > 0) {
      const frac = used / tokenLimit;
      rows.push({
        provider: prov.id,
        label,
        pct: frac * 100,
        status: statusOf(frac),
        detail: `${fmtTokens(used)} / ${fmtTokens(tokenLimit)} tok`,
        live: false,
        gauge: true,
      });
      continue;
    }
    const share = grandTotal > 0 ? (used / grandTotal) * 100 : 0;
    rows.push({
      provider: prov.id,
      label,
      pct: share,
      status: used > 0 ? "ok" : "unknown",
      // No configured limit → the bar would misread as utilization, so this
      // row renders without a gauge; the share of span usage is stated in text.
      detail: `${fmtTokens(used)} tok · ${share.toFixed(0)}% of ${spanLabel}`,
      live: false,
      gauge: false,
    });
  }
  return rows.sort((a, b) => (a.error ? 1 : 0) - (b.error ? 1 : 0) || b.pct - a.pct);
}
