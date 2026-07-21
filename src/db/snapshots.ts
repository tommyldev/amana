/**
 * Persistence for live usage snapshots. The limits/usage APIs most providers
 * expose (zai, anthropic, google, …) only return the *current* `used` total
 * for a reset window — there is no per-call or per-hour token feed. To chart
 * token usage for those providers we record each polled snapshot here and
 * derive a consumption rate by differencing consecutive samples within the
 * same reset window. Providers with log ingestion (omp, claude-code, admin
 * keys) keep using `usage_events`; this table fills the gap for everyone else.
 */
import type { Database } from "bun:sqlite";
import type { UsageReport } from "../usage/types.ts";

export interface SnapshotDeltaOpts {
  buckets: number;
  /** Restrict to a single provider (drill-in view). */
  provider?: string;
  /** Restrict to a single unit, e.g. `"tokens"` for the overview total. */
  unit?: string;
  /** Providers to skip (they already have log-derived data). */
  excludeProviders?: Set<string>;
  /** Deltas spanning a gap larger than this are dropped (default 10 min) —
   *  prevents a single sample landed after a long idle period from spiking
   *  one bucket. */
  maxGapMs?: number;
}

interface Row {
  fetched_at_ms: number;
  provider: string;
  limit_id: string;
  used: number | null;
  resets_at_ms: number | null;
}

const DEFAULT_MAX_GAP_MS = 10 * 60 * 1000;

function isFiniteNum(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/**
 * Insert one row per `(report, limit)` whose `amount.used` is a finite number.
 * `nowMs` is unused — each row is stamped with its report's `fetchedAt` so the
 * series reflects when the provider was actually polled. Returns rows inserted.
 */
export function recordSnapshots(db: Database, reports: UsageReport[]): number {
  const stmt = db.query(
    `INSERT INTO usage_snapshots
       (fetched_at_ms, provider, account, limit_id, used, limit_amount, unit, resets_at_ms)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  let n = 0;
  const tx = db.transaction((rs: UsageReport[]) => {
    for (const r of rs) {
      for (const l of r.limits) {
        const used = l.amount.used;
        if (!isFiniteNum(used)) continue;
        n += stmt.run(
          r.fetchedAt,
          r.provider,
          r.account,
          l.id,
          used,
          isFiniteNum(l.amount.limit) ? l.amount.limit : null,
          l.amount.unit,
          l.window?.resetsAt ?? null,
        ).changes;
      }
    }
  });
  tx(reports);
  return n;
}

/** Delete snapshots older than `cutoffMs`. Returns rows deleted. */
export function pruneSnapshots(db: Database, cutoffMs: number): number {
  return db.query(`DELETE FROM usage_snapshots WHERE fetched_at_ms < ?`).run(cutoffMs).changes;
}

/**
 * Per-bucket consumption derived from recorded snapshot deltas. Each delta is
 * `cur.used - prev.used` for consecutive samples of the same `(provider,
 * limit_id)` that share a reset window (`resets_at_ms` unchanged) and whose
 * `used` did not decrease. Deltas are attributed to the bucket of the later
 * sample. Multiple limits of one provider (e.g. 5h + 7d windows) describe the
 * same underlying consumption, so per provider we take the elementwise max
 * across its limits before summing providers — never the sum, which would
 * double-count. Returns `buckets` values spanning `[startMs, endMs)`.
 */
export function snapshotDeltaSeries(
  db: Database,
  startMs: number,
  endMs: number,
  opts: SnapshotDeltaOpts,
): number[] {
  const { buckets } = opts;
  if (buckets <= 0 || endMs <= startMs) return new Array(Math.max(buckets, 0)).fill(0);
  const maxGap = opts.maxGapMs ?? DEFAULT_MAX_GAP_MS;
  const span = endMs - startMs;
  const step = Math.max(Math.floor(span / buckets), 1);

  // Pad by one step so the first in-window sample has a predecessor.
  const where: string[] = ["fetched_at_ms >= ?"];
  const args: (string | number)[] = [startMs - step];
  if (opts.provider !== undefined) {
    where.push("provider = ?");
    args.push(opts.provider);
  }
  if (opts.unit !== undefined) {
    where.push("unit = ?");
    args.push(opts.unit);
  }
  if (opts.excludeProviders && opts.excludeProviders.size > 0) {
    const ph = [...opts.excludeProviders].map(() => "?").join(",");
    where.push(`provider NOT IN (${ph})`);
    args.push(...opts.excludeProviders);
  }
  const rows = db
    .query(
      `SELECT fetched_at_ms, provider, limit_id, used, resets_at_ms
       FROM usage_snapshots
       WHERE ${where.join(" AND ")}
       ORDER BY provider, limit_id, fetched_at_ms`,
    )
    .all(...args) as Row[];

  // Per (provider, limit_id) delta series.
  const byLimit = new Map<string, { provider: string; series: number[] }>();
  let curKey = "";
  let prev: Row | null = null;
  let curSeries: number[] = new Array(buckets).fill(0);
  let curProvider = "";
  const flush = () => {
    if (curKey) byLimit.set(curKey, { provider: curProvider, series: curSeries });
    curKey = "";
    prev = null;
  };
  for (const row of rows) {
    const key = `${row.provider}\0${row.limit_id}`;
    if (key !== curKey) {
      flush();
      curKey = key;
      curProvider = row.provider;
      curSeries = new Array(buckets).fill(0);
      prev = row;
      continue;
    }
    const p = prev;
    if (
      p &&
      p.used !== null &&
      row.used !== null &&
      row.used >= p.used &&
      p.resets_at_ms === row.resets_at_ms &&
      row.fetched_at_ms - p.fetched_at_ms <= maxGap &&
      row.fetched_at_ms >= startMs &&
      row.fetched_at_ms < endMs
    ) {
      const idx = Math.floor((row.fetched_at_ms - startMs) / step);
      if (idx >= 0 && idx < buckets) curSeries[idx]! += row.used - p.used;
    }
    prev = row;
  }
  flush();

  // Elementwise max per provider, then sum across providers.
  const out = new Array<number>(buckets).fill(0);
  const byProvider = new Map<string, number[]>();
  for (const { provider, series } of byLimit.values()) {
    const acc = byProvider.get(provider);
    if (!acc) {
      byProvider.set(provider, [...series]);
    } else {
      for (let i = 0; i < buckets; i++) acc[i] = Math.max(acc[i]!, series[i]!);
    }
  }
  for (const series of byProvider.values()) {
    for (let i = 0; i < buckets; i++) out[i]! += series[i]!;
  }
  return out;
}

export interface SnapshotLevel {
  /** Last `used` sample per bucket (0 where no poll landed). */
  series: number[];
  unit: string;
  latestUsed: number;
  latestLimit: number | null;
}

/**
 * Quota-fill level over time for one provider: the raw `used` ramp of its
 * most binding window (largest used/limit at the latest poll). Unlike the
 * delta series this is meaningful from the very first poll — it charts how
 * full the quota is, not how fast it is being consumed — so the drill-in
 * has something to show while deltas accumulate. Returns null when the
 * provider has no snapshots at all.
 */
export function snapshotLevelSeries(
  db: Database,
  startMs: number,
  endMs: number,
  provider: string,
  buckets: number,
): SnapshotLevel | null {
  if (buckets <= 0 || endMs <= startMs) return null;
  const latest = db
    .query(
      `SELECT limit_id, used, limit_amount, unit, fetched_at_ms
       FROM usage_snapshots WHERE provider = ?
       ORDER BY fetched_at_ms DESC LIMIT 16`,
    )
    .all(provider) as {
    limit_id: string;
    used: number | null;
    limit_amount: number | null;
    unit: string;
    fetched_at_ms: number;
  }[];
  if (latest.length === 0) return null;
  // Rows from the newest poll only; pick the most binding window.
  const newest = latest.filter((r) => r.fetched_at_ms === latest[0]!.fetched_at_ms);
  let pick = newest[0]!;
  let pickRatio = -1;
  for (const r of newest) {
    const ratio =
      r.used !== null && r.limit_amount !== null && r.limit_amount > 0
        ? r.used / r.limit_amount
        : (r.used ?? 0) > 0
          ? 0
          : -1;
    if (ratio > pickRatio || (ratio === pickRatio && (r.used ?? 0) > (pick.used ?? 0))) {
      pick = r;
      pickRatio = ratio;
    }
  }

  const step = Math.max(Math.floor((endMs - startMs) / buckets), 1);
  const series = new Array<number>(buckets).fill(0);
  const rows = db
    .query(
      `SELECT fetched_at_ms, used FROM usage_snapshots
       WHERE provider = ? AND limit_id = ? AND fetched_at_ms >= ? AND fetched_at_ms < ?
       ORDER BY fetched_at_ms`,
    )
    .all(provider, pick.limit_id, startMs, endMs) as { fetched_at_ms: number; used: number | null }[];
  for (const r of rows) {
    if (r.used === null) continue;
    const idx = Math.floor((r.fetched_at_ms - startMs) / step);
    if (idx >= 0 && idx < buckets) series[idx] = r.used;
  }
  return { series, unit: pick.unit, latestUsed: pick.used ?? 0, latestLimit: pick.limit_amount };
}
