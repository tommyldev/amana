/**
 * Data loop for the TUI. One cycle:
 *   1. mark syncing
 *   2. runSync (incremental)
 *   3. fetchAll (live usage per credential)
 *   4. hourlyByProvider over the last `span` hours + elementwise total
 *   5. accounts: walk credentials, compute label + expiry + matching error
 *   6. alerts.checkAndFire — banner shows the LATEST fired event
 *   7. dispatch setData + setSyncing(false)
 *
 * Overlapping cycles are skipped via an in-flight ref so a slow refresh
 * never doubles up. The interval re-arms every `cfg.ui.refresh_interval_seconds`
 * seconds AND when `span` changes (the token window must follow the selected
 * span). The `r` key in App calls the returned `refresh()` directly.
 *
 * Every stage is wrapped in try/catch — a thrown error in one stage must
 * never kill the loop or leave `syncing` stuck on.
 */
import { useCallback, useEffect, useRef } from "react";
import type { Database } from "bun:sqlite";
import type { Config } from "../config/types.ts";
import type { ProviderHourly } from "../db/types.ts";
import type { UsageReport } from "../usage/types.ts";
import type { FetchError } from "../usage/orchestrator.ts";
import type { AccountRow, Action } from "./state.ts";
import { runSync } from "../ingest/sync.ts";
import { fetchAll } from "../usage/orchestrator.ts";
import { hourlyByProvider, windowSeries } from "../db/series.ts";
import { allProviders, load } from "../auth/store.ts";
import { accountLabel } from "../auth/types.ts";
import { checkAndFire } from "../alerts/engine.ts";
import { localAlertReports } from "../alerts/local.ts";
import { buildSnapshot, sourcesFor, type Snapshot } from "../report/snapshot.ts";
import { buildOverviewRows, type OverviewRow } from "./views/derive.ts";
import { buildLimitRows, type LimitRow } from "./views/limitRows.ts";
import { byId } from "../registry.ts";
import { recordSnapshots, pruneSnapshots, snapshotDeltaSeries } from "../db/snapshots.ts";

const HOUR_MS = 3_600_000;

/** OAuth expiry as a human string relative to now. */
function oauthExpiry(expires: number | undefined, nowMs: number): string {
  if (expires === undefined) return "no expiry";
  const delta = expires - nowMs;
  if (delta <= 0) return "expired";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes - hours * 60;
  return remMin === 0 ? `in ${hours}h` : `in ${hours}h${remMin}m`;
}

/** Build the per-account rows the Accounts tab renders. Pulls the error
 *  string off the matching FetchError (if any) so the UI can show why a
 *  credential failed without a second lookup. */
function buildAccountRows(dataDir: string, errors: FetchError[], nowMs: number): AccountRow[] {
  const errorByKey = new Map<string, string>();
  for (const e of errors) errorByKey.set(`${e.provider}\u0001${e.account}`, e.message);

  const rows: AccountRow[] = [];
  for (const provider of allProviders(dataDir)) {
    for (const cred of load(dataDir, provider)) {
      const label = accountLabel(cred);
      const expiry = cred.type === "oauth" ? oauthExpiry(cred.expires, nowMs) : "-";
      const row: AccountRow = { provider, label, kind: cred.type, expiry };
      const errMsg = errorByKey.get(`${provider}\u0001${label}`);
      if (errMsg !== undefined) row.error = errMsg;
      rows.push(row);
    }
  }
  return rows;
}

export function useRefresh(args: {
  db: Database;
  cfg: Config;
  dataDir: string;
  span: number;
  dispatch: (a: Action) => void;
}): () => void {
  const { db, cfg, dataDir, span, dispatch } = args;
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    dispatch({ t: "setSyncing", on: true });

    try {
      // 1. Sync (ingest local log sources).
      try {
        await runSync(db, cfg, dataDir, false);
      } catch (e) {
        console.error("[amana] runSync failed:", e instanceof Error ? e.message : e);
      }

      // 2. Live usage fetches per stored credential.
      let reports: UsageReport[] = [];
      let errors: FetchError[] = [];
      try {
        const result = await fetchAll(db, dataDir, {});
        reports = result.reports;
        errors = result.errors;
      } catch (e) {
        console.error("[amana] fetchAll failed:", e instanceof Error ? e.message : e);
      }

      // 2b. Persist + prune snapshots. Cheap DB writes; one shared catch so a
      // prune failure can't stop a record (and vice versa).
      try {
        recordSnapshots(db, reports);
        pruneSnapshots(db, Date.now() - 30 * 24 * 60 * 60 * 1000);
      } catch (e) {
        console.error("[amana] recordSnapshots failed:", e instanceof Error ? e.message : e);
      }

      // 3. Hourly token series for the current span window.
      let tokenSeries: ProviderHourly[] = [];
      const totalSeries: number[] = new Array<number>(span).fill(0);
      try {
        const startMs = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - (span - 1) * HOUR_MS;
        tokenSeries = hourlyByProvider(db, startMs, HOUR_MS, span);
        for (const p of tokenSeries) {
          for (let i = 0; i < span; i++) totalSeries[i] += p.buckets[i] ?? 0;
        }

        // Snapshot deltas: providers with only a limits API (zai/anthropic/
        // google/xai/...) feed the overview chart here. Exclude providers
        // already covered by log ingestion to avoid double-counting. Wrapped
        // separately so a snapshot failure can't corrupt the log-derived
        // totalSeries.
        try {
          const logProviders = new Set(tokenSeries.filter((p) => p.totalTokens > 0).map((p) => p.provider));
          const snapTokens = snapshotDeltaSeries(db, startMs, startMs + span * HOUR_MS, { buckets: span, unit: "tokens", excludeProviders: logProviders });
          for (let i = 0; i < span; i++) totalSeries[i] = (totalSeries[i] ?? 0) + (snapTokens[i] ?? 0);
        } catch (e) {
          console.error("[amana] snapshotDeltaSeries failed:", e instanceof Error ? e.message : e);
        }
      } catch (e) {
        console.error("[amana] hourlyByProvider failed:", e instanceof Error ? e.message : e);
      }

      // 4. Accounts.
      let accounts: AccountRow[] = [];
      try {
        accounts = buildAccountRows(dataDir, errors, Date.now());
      } catch (e) {
        console.error("[amana] account build failed:", e instanceof Error ? e.message : e);
      }

      // 4b. Overview rows: live quota when logged in, else per-provider token
      // usage over the selected span (source-scoped so aggregate ids like
      // omp/claude-code attribute correctly).
      let overviewRows: OverviewRow[] = [];
      try {
        const startMs = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - (span - 1) * HOUR_MS;
        const endMs = startMs + span * HOUR_MS;
        const spanTotals = new Map<string, number>();
        for (const prov of cfg.providers) {
          if (!prov.enabled) continue;
          const buckets = windowSeries(db, startMs, endMs, sourcesFor(prov.id), byId(prov.id)?.ompProvider ?? undefined, span);
          spanTotals.set(prov.id, buckets.reduce((s, v) => s + v, 0));
        }
        overviewRows = buildOverviewRows(cfg, reports, errors, spanTotals, span);
      } catch (e) {
        console.error("[amana] overview build failed:", e instanceof Error ? e.message : e);
      }

      // 4c. Limit rows (default view): live quota, else configured caps.
      let limitRows: LimitRow[] = [];
      let snap: Snapshot | undefined;
      try {
        snap = buildSnapshot(db, cfg, Date.now());
        limitRows = buildLimitRows(cfg, reports, errors, snap);
      } catch (e) {
        console.error("[amana] limits build failed:", e instanceof Error ? e.message : e);
      }

      // 5. Alerts → banner. Local providers with a configured token cap are
      // evaluated alongside live quota (deduped per reset) — no login needed.
      try {
        const liveProviders = new Set(reports.map((r) => r.provider));
        const localReports = snap ? localAlertReports(cfg, snap, liveProviders) : [];
        const fired = checkAndFire(db, cfg.alerts, [...reports, ...localReports]);
        const last = fired[fired.length - 1];
        if (last) {
          dispatch({
            t: "setBanner",
            text: `⚠ ${last.provider} ${last.account} ${last.limitLabel} at ${Math.round(last.usedPct)}% (≥${last.threshold}%)`,
          });
        }
      } catch (e) {
        console.error("[amana] checkAndFire failed:", e instanceof Error ? e.message : e);
      }

      // 6. Push the snapshot.
      dispatch({ t: "setData", overviewRows, limitRows, reports, errors, tokenSeries, totalSeries, accounts });
    } finally {
      inFlight.current = false;
      dispatch({ t: "setSyncing", on: false });
    }
  }, [db, cfg, dataDir, span, dispatch]);

  // Re-run on mount + every interval + whenever span changes.
  useEffect(() => {
    let cancelled = false;
    const intervalSec = Math.max(1, cfg.ui.refresh_interval_seconds);

    const tick = () => {
      if (cancelled || inFlight.current) return;
      void refresh();
    };

    tick();
    const id = setInterval(tick, intervalSec * 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [refresh, cfg.ui.refresh_interval_seconds]);

  return refresh;
}