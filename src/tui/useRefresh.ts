/**
 * Data loop for the TUI. Two paths share one `refresh(mode)` entry point:
 *
 *  - "full" (mount, periodic interval, `r` key): runSync → fetchAll →
 *    snapshots → accounts → limitRows → alerts, then the span view is
 *    computed and the per-span cache is rebuilt. Expensive (network + ingest).
 *  - "span" (span cycle via the `t` key): no sync, no fetch. Reads the
 *    span-independent products (reports/accounts/limitRows) and either a
 *    previously computed per-span view, or a cheap DB-only recompute, from
 *    the cache populated by the last full refresh.
 *
 * `refresh` reads the current span from a ref, so its identity is stable
 * across span changes — the periodic interval does not tear down when the
 * user cycles spans. Every stage is wrapped in try/catch so a thrown error
 * can never kill the loop or leave `syncing` stuck on.
 */
import { useCallback, useEffect, useRef } from "react";
import type { Database } from "bun:sqlite";
import type { Config } from "../config/types.ts";
import type { ProviderHourly } from "../db/types.ts";
import type { UsageReport } from "../usage/types.ts";
import type { FetchError } from "../usage/orchestrator.ts";
import type { AccountRow, Action } from "./state.ts";
import type { SpanWindow } from "./spans.ts";
import { runSync } from "../ingest/sync.ts";
import { fetchAll } from "../usage/orchestrator.ts";
import { earliestEventMs, hourlyByProvider, windowSeries } from "../db/series.ts";
import { allProviders, load } from "../auth/store.ts";
import { accountLabel } from "../auth/types.ts";
import { checkAndFire } from "../alerts/engine.ts";
import { localAlertReports } from "../alerts/local.ts";
import { buildSnapshot, sourcesFor, type Snapshot } from "../report/snapshot.ts";
import { buildOverviewRows, type OverviewRow } from "./views/derive.ts";
import { buildLimitRows, type LimitRow } from "./views/limitRows.ts";
import { byId } from "../registry.ts";
import { recordSnapshots, pruneSnapshots, snapshotDeltaSeries } from "../db/snapshots.ts";
import { spanById, spanWindow } from "./spans.ts";
import { readLaunchCache, writeLaunchCache } from "./launchCache.ts";

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

interface SpanView {
  spanWindow: SpanWindow;
  totalSeries: number[];
  tokenSeries: ProviderHourly[];
  overviewRows: OverviewRow[];
}

interface Cached {
  reports: UsageReport[];
  errors: FetchError[];
  accounts: AccountRow[];
  limitRows: LimitRow[];
  spans: Map<string, SpanView>;
}

/** Span-dependent slice (chart series + overview rows) derived purely from
 *  the DB + the cached live reports. This is the only work a span switch does. */
function computeSpanView(
  db: Database,
  cfg: Config,
  spanId: string,
  nowMs: number,
  reports: UsageReport[],
  errors: FetchError[],
): SpanView {
  const span = spanById(spanId);
  const win = spanWindow(span, nowMs, earliestEventMs(db));

  let tokenSeries: ProviderHourly[] = [];
  const totalSeries: number[] = new Array<number>(win.buckets).fill(0);
  try {
    tokenSeries = hourlyByProvider(db, win.startMs, win.bucketMs, win.buckets);
    for (const p of tokenSeries) {
      for (let i = 0; i < win.buckets; i++) totalSeries[i] += p.buckets[i] ?? 0;
    }
    // Snapshot deltas feed limits-API-only providers; exclude log-covered
    // providers so they aren't double-counted. Separate catch so a snapshot
    // failure can't corrupt the log-derived total.
    try {
      const logProviders = new Set(tokenSeries.filter((p) => p.totalTokens > 0).map((p) => p.provider));
      const snapTokens = snapshotDeltaSeries(db, win.startMs, win.endMs, { buckets: win.buckets, unit: "tokens", excludeProviders: logProviders });
      for (let i = 0; i < win.buckets; i++) totalSeries[i] = (totalSeries[i] ?? 0) + (snapTokens[i] ?? 0);
    } catch (e) {
      console.error("[Agent Mana] snapshotDeltaSeries failed:", e instanceof Error ? e.message : e);
    }
  } catch (e) {
    console.error("[Agent Mana] hourlyByProvider failed:", e instanceof Error ? e.message : e);
  }

  let overviewRows: OverviewRow[] = [];
  try {
    const spanTotals = new Map<string, number>();
    for (const prov of cfg.providers) {
      if (!prov.enabled) continue;
      const buckets = windowSeries(db, win.startMs, win.endMs, sourcesFor(prov.id), byId(prov.id)?.ompProvider ?? undefined, win.buckets);
      spanTotals.set(prov.id, buckets.reduce((s, v) => s + v, 0));
    }
    overviewRows = buildOverviewRows(cfg, reports, errors, spanTotals, span.label);
  } catch (e) {
    console.error("[Agent Mana] overview build failed:", e instanceof Error ? e.message : e);
  }

  return { spanWindow: win, totalSeries, tokenSeries, overviewRows };
}

function dispatchData(dispatch: (a: Action) => void, c: Cached, view: SpanView): void {
  dispatch({
    t: "setData",
    overviewRows: view.overviewRows,
    limitRows: c.limitRows,
    reports: c.reports,
    errors: c.errors,
    tokenSeries: view.tokenSeries,
    totalSeries: view.totalSeries,
    accounts: c.accounts,
    spanWindow: view.spanWindow,
  });
}

export function useRefresh(args: {
  db: Database;
  cfg: Config;
  dataDir: string;
  spanId: string;
  dispatch: (a: Action) => void;
}): () => void {
  const { db, cfg, dataDir, dispatch } = args;
  const inFlight = useRef(false);
  const cacheRef = useRef<Cached | null>(null);
  const spanIdRef = useRef(args.spanId);
  useEffect(() => {
    spanIdRef.current = args.spanId;
  }, [args.spanId]);
  useEffect(() => {
    if (cacheRef.current) return;
    const lc = readLaunchCache(dataDir);
    if (!lc) return;
    cacheRef.current = {
      reports: lc.reports,
      errors: lc.errors,
      accounts: lc.accounts,
      limitRows: lc.limitRows,
      spans: new Map([
        [lc.spanId, { spanWindow: lc.spanWindow, totalSeries: lc.totalSeries, tokenSeries: lc.tokenSeries, overviewRows: lc.overviewRows }],
      ]),
    };
  }, [dataDir]);

  const refresh = useCallback(async (mode: "full" | "span" = "full"): Promise<void> => {
    const spanId = spanIdRef.current;

    // Cheap path: a span cycle with a warm cache serves from cache, or does a
    // DB-only recompute — never sync/fetch. No `syncing` indicator: it's fast.
    const cached = cacheRef.current;
    if (mode === "span" && cached) {
      let view = cached.spans.get(spanId);
      if (!view) {
        view = computeSpanView(db, cfg, spanId, Date.now(), cached.reports, cached.errors);
        cached.spans.set(spanId, view);
      }
      dispatchData(dispatch, cached, view);
      return;
    }

    if (inFlight.current) return;
    inFlight.current = true;
    dispatch({ t: "setSyncing", on: true });

    try {
      try {
        await runSync(db, cfg, dataDir, false);
      } catch (e) {
        console.error("[Agent Mana] runSync failed:", e instanceof Error ? e.message : e);
      }

      let reports: UsageReport[] = [];
      let errors: FetchError[] = [];
      try {
        const result = await fetchAll(db, dataDir, {});
        reports = result.reports;
        errors = result.errors;
      } catch (e) {
        console.error("[Agent Mana] fetchAll failed:", e instanceof Error ? e.message : e);
      }

      try {
        recordSnapshots(db, reports);
        pruneSnapshots(db, Date.now() - 30 * 24 * 60 * 60 * 1000);
      } catch (e) {
        console.error("[Agent Mana] recordSnapshots failed:", e instanceof Error ? e.message : e);
      }

      let accounts: AccountRow[] = [];
      try {
        accounts = buildAccountRows(dataDir, errors, Date.now());
      } catch (e) {
        console.error("[Agent Mana] account build failed:", e instanceof Error ? e.message : e);
      }

      let limitRows: LimitRow[] = [];
      let snap: Snapshot | undefined;
      try {
        snap = buildSnapshot(db, cfg, Date.now());
        limitRows = buildLimitRows(cfg, reports, errors, snap);
      } catch (e) {
        console.error("[Agent Mana] limits build failed:", e instanceof Error ? e.message : e);
      }

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
        console.error("[Agent Mana] checkAndFire failed:", e instanceof Error ? e.message : e);
      }

      const next: Cached = { reports, errors, accounts, limitRows, spans: new Map() };
      const view = computeSpanView(db, cfg, spanId, Date.now(), reports, errors);
      next.spans.set(spanId, view);
      cacheRef.current = next;
      dispatchData(dispatch, next, view);
      writeLaunchCache(dataDir, {
        savedAt: Date.now(),
        spanId,
        spanWindow: view.spanWindow,
        overviewRows: view.overviewRows,
        limitRows: next.limitRows,
        reports: next.reports,
        errors: next.errors,
        tokenSeries: view.tokenSeries,
        totalSeries: view.totalSeries,
        accounts: next.accounts,
      });
    } finally {
      inFlight.current = false;
      dispatch({ t: "setSyncing", on: false });
    }
  }, [db, cfg, dataDir, dispatch]);

  useEffect(() => {
    let cancelled = false;
    const intervalSec = Math.max(1, cfg.ui.refresh_interval_seconds);

    const tick = () => {
      if (cancelled || inFlight.current) return;
      void refresh("full");
    };

    tick();
    const id = setInterval(tick, intervalSec * 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [refresh, cfg.ui.refresh_interval_seconds]);

  useEffect(() => {
    void refresh("span");
  }, [args.spanId, refresh]);

  return refresh;
}
