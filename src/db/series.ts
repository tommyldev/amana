import type { Database } from "bun:sqlite";
import type { ProviderHourly } from "./types.ts";

/**
 * Total-token sums split into `buckets` equal time slices spanning
 * [startMs, nextResetMs). Port of Rust `window_series`.
 */
export function windowSeries(
  db: Database,
  startMs: number,
  nextResetMs: number,
  sources: string[],
  provider: string | undefined,
  buckets: number,
): number[] {
  if (buckets <= 0 || sources.length === 0) return new Array(Math.max(buckets, 0)).fill(0);
  const step = Math.max(Math.floor((nextResetMs - startMs) / buckets), 1);
  const placeholders = sources.map(() => "?").join(",");
  const provClause = provider !== undefined ? " AND provider = ?" : "";
  const sql = `SELECT (timestamp_ms - ?) / ? AS b, COALESCE(SUM(total_tokens),0) AS tok
    FROM usage_events
    WHERE timestamp_ms >= ? AND timestamp_ms < ? AND source IN (${placeholders})${provClause}
    GROUP BY b`;
  const args: (string | number)[] = [startMs, step, startMs, nextResetMs, ...sources];
  if (provider !== undefined) args.push(provider);
  const out = new Array<number>(buckets).fill(0);
  for (const row of db.query(sql).all(...args) as { b: number; tok: number }[]) {
    const idx = row.b;
    if (idx >= 0 && idx < out.length) out[idx] = row.tok;
  }
  return out;
}

/**
 * Per-provider token totals bucketed into `buckets` slices of `bucketMs`
 * starting at `startMs`. Sorted by total tokens desc, then provider asc.
 */
export function hourlyByProvider(
  db: Database,
  startMs: number,
  bucketMs: number,
  buckets: number,
): ProviderHourly[] {
  if (buckets <= 0) return [];
  const endMs = startMs + bucketMs * buckets;
  const sql = `SELECT provider, (timestamp_ms - ?) / ? AS b,
      COALESCE(SUM(total_tokens),0) AS tok, COALESCE(SUM(cost_usd),0.0) AS cost
    FROM usage_events
    WHERE timestamp_ms >= ? AND timestamp_ms < ?
    GROUP BY provider, b`;
  const rows = db.query(sql).all(startMs, bucketMs, startMs, endMs) as {
    provider: string;
    b: number;
    tok: number;
    cost: number;
  }[];
  const map = new Map<string, ProviderHourly>();
  for (const row of rows) {
    if (row.b < 0 || row.b >= buckets) continue;
    let entry = map.get(row.provider);
    if (!entry) {
      entry = { provider: row.provider, buckets: new Array<number>(buckets).fill(0), totalTokens: 0, estCost: 0 };
      map.set(row.provider, entry);
    }
    entry.buckets[row.b] = row.tok;
    entry.totalTokens += row.tok;
    entry.estCost += row.cost;
  }
  return [...map.values()].sort(
    (a, b) => b.totalTokens - a.totalTokens || a.provider.localeCompare(b.provider),
  );
}
