import type { Database } from "bun:sqlite";
import type { ModelBreakdown, UsageEventRow } from "./types.ts";

export function breakdownByModel(
  db: Database,
  startMs: number,
  nextResetMs: number,
  sources: string[],
  provider?: string,
): ModelBreakdown[] {
  if (sources.length === 0) return [];
  const placeholders = sources.map(() => "?").join(",");
  const provClause = provider !== undefined ? " AND provider = ?" : "";
  const sql = `SELECT model, COUNT(*) AS requests, COALESCE(SUM(total_tokens),0) AS total_tokens,
      COALESCE(SUM(cost_usd),0.0) AS cost
    FROM usage_events
    WHERE timestamp_ms >= ? AND timestamp_ms < ? AND source IN (${placeholders})${provClause}
    GROUP BY model
    ORDER BY SUM(total_tokens) DESC`;
  const args: (string | number)[] = [startMs, nextResetMs, ...sources];
  if (provider !== undefined) args.push(provider);
  return db.query(sql).all(...args) as ModelBreakdown[];
}

export function recentEvents(
  db: Database,
  sources: string[],
  provider: string | undefined,
  limit: number,
): UsageEventRow[] {
  if (sources.length === 0 || limit <= 0) return [];
  const placeholders = sources.map(() => "?").join(",");
  const provClause = provider !== undefined ? " AND provider = ?" : "";
  const sql = `SELECT source, source_message_id, timestamp_ms, provider, model,
      prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens,
      total_tokens, cost_usd, cost_origin
    FROM usage_events
    WHERE source IN (${placeholders})${provClause}
    ORDER BY timestamp_ms DESC
    LIMIT ?`;
  const args: (string | number)[] = [...sources];
  if (provider !== undefined) args.push(provider);
  args.push(limit);
  return db.query(sql).all(...args) as UsageEventRow[];
}
