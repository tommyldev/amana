import type { Config } from "../../config/types.ts";
import { resolveUsedFraction, statusOf, type UsageReport, type UsageStatus } from "../../usage/types.ts";
import type { FetchError } from "../../usage/orchestrator.ts";
import { fmtTokens } from "../../report/format.ts";
import { type Snapshot } from "../../report/snapshot.ts";

/** One row in the Limits view: a live provider-quota limit, a configured
 *  token/cost cap, or a guidance row when a provider has neither. */
export interface LimitRow {
  provider: string;
  label: string;
  account?: string;
  limitLabel: string;
  pct: number;
  detail: string;
  status: UsageStatus;
  resetsAt?: number;
  live: boolean;
  gauge: boolean;
  error?: string;
}

/**
 * Limits across every enabled provider. Live quota limits (per account, from
 * `amana login`) come first with real caps + resets; otherwise one row per
 * configured window (from `defaults`/`amana window set`) plus any cost cap,
 * else a guidance row. Local reset times come from each window's own
 * `active.nextReset` so the TUI matches `amana report`.
 */
export function buildLimitRows(
  cfg: Config,
  reports: UsageReport[],
  errors: FetchError[],
  snap: Snapshot,
): LimitRow[] {
  const rows: LimitRow[] = [];
  for (let i = 0; i < cfg.providers.length; i++) {
    const prov = cfg.providers[i]!;
    if (!prov.enabled) continue;
    const label = snap.providers[i]!.label;

    let added = false;
    for (const r of reports.filter((x) => x.provider === prov.id)) {
      for (const l of r.limits) {
        const frac = resolveUsedFraction(l) ?? 0;
        rows.push({
          provider: prov.id,
          label,
          account: r.account,
          limitLabel: l.label,
          pct: frac * 100,
          detail: `${(frac * 100).toFixed(0)}% used`,
          status: statusOf(frac),
          resetsAt: l.window?.resetsAt,
          live: true,
          gauge: true,
        });
        added = true;
      }
    }

    const err = errors.find((e) => e.provider === prov.id);
    if (err) {
      rows.push({ provider: prov.id, label, limitLabel: "error", pct: 0, detail: err.message, status: "unknown", live: false, gauge: false, error: err.message });
      continue;
    }
    if (added) continue;

    // One row per CONFIGURED window (primary + extras) for local providers.
    // Only the primary carries a token budget (window_token_limit); secondary
    // windows render usage-only. resetsAt comes from each window's own reset so
    // the TUI Limits view matches `amana report` — calendar + epoch-grid
    // rolling resets are deterministic, so surfacing them is accurate.
    for (const w of snap.providers[i]!.windows) {
      const limit = w.tokenLimit;
      if (limit !== undefined && limit > 0) {
        const frac = w.usage.total / limit;
        rows.push({
          provider: prov.id,
          label,
          limitLabel: `token budget · ${w.desc}`,
          pct: Math.min(frac * 100, 100),
          detail: `${fmtTokens(w.usage.total)} / ${fmtTokens(limit)} tok`,
          status: statusOf(frac),
          resetsAt: w.active?.nextReset,
          live: false,
          gauge: true,
        });
      } else {
        rows.push({
          provider: prov.id,
          label,
          limitLabel: `usage · ${w.desc}`,
          pct: 0,
          detail: `${fmtTokens(w.usage.total)} tok`,
          status: "unknown",
          resetsAt: w.active?.nextReset,
          live: false,
          gauge: false,
        });
      }
    }
    const costCap = prov.limits.monthly_cost;
    if (costCap !== undefined) {
      const used = snap.providers[i]!.monthCostUsed ?? 0;
      const frac = costCap > 0 ? used / costCap : 0;
      rows.push({
        provider: prov.id,
        label,
        limitLabel: "monthly cost cap",
        pct: Math.min(frac * 100, 100),
        detail: `$${used.toFixed(2)} / $${costCap.toFixed(2)}`,
        status: statusOf(frac),
        live: false,
        gauge: true,
      });
    }
  }
  return rows;
}
