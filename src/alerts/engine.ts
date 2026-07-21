import type { Database } from "bun:sqlite";
import type { AlertsCfg } from "../config/types.ts";
import type { UsageLimit, UsageReport } from "../usage/types.ts";
import { alertAlreadyFired, markAlertFired, type AlertKey } from "../db/alertState.ts";
import { notify } from "./notify.ts";

/**
 * One fired alert. `usedPct` is the percentage that was crossed (0–100).
 * `resetsAt` is propagated from the source `UsageLimit.window` when present
 * so downstream consumers (TUI banner, test assertions) can correlate
 * alerts to their reset cycle.
 */
export interface AlertEvent {
  provider: string;
  account: string;
  limitId: string;
  limitLabel: string;
  threshold: number;
  usedPct: number;
  resetsAt?: number;
}

/**
 * Compute alert candidates from a set of usage reports.
 *
 * For each `UsageLimit` with a numeric `amount.usedFraction`, emit ONE
 * event at the HIGHEST configured threshold <= usedFraction*100.
 * Thresholds are sorted ascending; if none are crossed, no event is
 * emitted for that limit. `usedFraction === undefined` is treated as
 * unknown and skipped entirely.
 *
 * Pure: no side effects, safe to call from tests.
 */
export function candidates(reports: UsageReport[], thresholds: number[]): AlertEvent[] {
  const sorted = [...thresholds].sort((a, b) => a - b);
  const out: AlertEvent[] = [];
  for (const report of reports) {
    for (const limit of report.limits) {
      const ev = candidateForLimit(report.provider, report.account, limit, sorted);
      if (ev) out.push(ev);
    }
  }
  return out;
}

function candidateForLimit(
  provider: string,
  account: string,
  limit: UsageLimit,
  sortedThresholds: number[],
): AlertEvent | undefined {
  const frac = limit.amount.usedFraction;
  if (frac === undefined || frac === null) return undefined;
  const usedPct = frac * 100;
  // Highest threshold that was actually crossed (<= usedPct).
  let crossed: number | undefined;
  for (const t of sortedThresholds) {
    if (t <= usedPct) crossed = t;
  }
  if (crossed === undefined) return undefined;
  const resetsAt = limit.window?.resetsAt;
  return {
    provider,
    account,
    limitId: limit.id,
    limitLabel: limit.label,
    threshold: crossed,
    usedPct,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

/**
 * Compute candidates and fire any that have not already fired in this
 * epoch. Returns the events that fired THIS call.
 *
 * Dedup key: (provider, account, limitId, threshold, epoch).
 *   epoch = String(floor(resetsAt/3_600_000))   when resetsAt is present,
 *        = String(<UTC YYYY-MM-DD>)             when it is not.
 *
 * Contingency: when resetsAt is present, we coarsen it to the hour bucket
 * before stringifying. Providers occasionally nudge resetsAt by a few
 * seconds between polls; the hour bucket absorbs that jitter so we don't
 * re-fire on every cycle.
 */
export function checkAndFire(
  db: Database,
  alertsCfg: AlertsCfg,
  reports: UsageReport[],
): AlertEvent[] {
  if (!alertsCfg.enabled) return [];
  const evts = candidates(reports, alertsCfg.thresholds);
  const fired: AlertEvent[] = [];
  const now = Date.now();
  for (const ev of evts) {
    const epoch = ev.resetsAt !== undefined
      ? String(Math.floor(ev.resetsAt / 3_600_000))
      : utcDateString(now);
    const key: AlertKey = {
      provider: ev.provider,
      account: ev.account,
      limitId: ev.limitId,
      threshold: ev.threshold,
      epoch,
    };
    if (alertAlreadyFired(db, key)) continue;
    markAlertFired(db, key, now);
    if (alertsCfg.desktop) {
      notify(
        `Agent Mana: ${ev.provider} ${Math.round(ev.usedPct)}% used`,
        `${ev.account} · ${ev.limitLabel} · threshold ${ev.threshold}%`,
      );
    }
    fired.push(ev);
  }
  return fired;
}

function utcDateString(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}