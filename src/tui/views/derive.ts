import type { UsageLimit, UsageReport } from "../../usage/types.ts";
import type { FetchError } from "../../usage/orchestrator.ts";

/** Percent (0..100+) of a limit consumed. */
export function limitPct(l: UsageLimit): number {
  const a = l.amount;
  if (a.usedFraction != null) return a.usedFraction * 100;
  if (a.used != null && a.limit != null && a.limit > 0) return (a.used / a.limit) * 100;
  return 0;
}

export interface LimitRow {
  provider: string;
  account: string;
  label: string;
  pct: number;
  resetsAt?: number;
  error?: string;
}

/**
 * One row per provider for the Limits overview: the single most-pressured
 * limit across all of that provider's accounts. Providers that produced only
 * a fetch error (no report) get an error row. Sorted: healthy/pressured first
 * by pct desc, error rows last.
 */
export function deriveLimitRows(reports: UsageReport[], errors: FetchError[]): LimitRow[] {
  const byProvider = new Map<string, LimitRow>();
  const haveReport = new Set<string>();
  for (const r of reports) {
    haveReport.add(r.provider);
    for (const l of r.limits) {
      const pct = limitPct(l);
      const prev = byProvider.get(r.provider);
      if (!prev || pct > prev.pct) {
        byProvider.set(r.provider, {
          provider: r.provider,
          account: r.account,
          label: l.label,
          pct,
          resetsAt: l.window?.resetsAt,
        });
      }
    }
  }
  for (const e of errors) {
    if (!haveReport.has(e.provider) && !byProvider.has(e.provider)) {
      byProvider.set(e.provider, { provider: e.provider, account: e.account, label: "", pct: 0, error: e.message });
    }
  }
  return [...byProvider.values()].sort(
    (a, b) => (a.error ? 1 : 0) - (b.error ? 1 : 0) || b.pct - a.pct,
  );
}
