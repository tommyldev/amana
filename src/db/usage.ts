import type { Database } from "bun:sqlite";
import type { UsageAggregate, UsageEventRow } from "./types.ts";

const COLS =
  "(source, source_message_id, timestamp_ms, provider, model, prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens, total_tokens, cost_usd, cost_origin)";
const VALS = "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)";

function bind(r: UsageEventRow): (string | number | null)[] {
  return [
    r.source, r.source_message_id, r.timestamp_ms, r.provider, r.model,
    r.prompt_tokens, r.completion_tokens, r.cache_read_tokens, r.cache_write_tokens,
    r.total_tokens, r.cost_usd, r.cost_origin,
  ];
}

function runInsert(db: Database, sql: string, rows: UsageEventRow[]): number {
  const stmt = db.query(sql);
  let n = 0;
  const tx = db.transaction((rs: UsageEventRow[]) => {
    for (const r of rs) n += stmt.run(...bind(r)).changes;
  });
  tx(rows);
  return n;
}

export function insertEvents(db: Database, rows: UsageEventRow[]): number {
  return runInsert(db, `INSERT OR IGNORE INTO usage_events ${COLS} ${VALS}`, rows);
}

/** Upsert taking MAX of token fields; cost precedence api > computed > logged. */
export function insertEventsDedupCompletion(db: Database, rows: UsageEventRow[]): number {
  return runInsert(
    db,
    `INSERT INTO usage_events ${COLS} ${VALS}
     ON CONFLICT(source, source_message_id) DO UPDATE SET
       completion_tokens = MAX(usage_events.completion_tokens, excluded.completion_tokens),
       prompt_tokens = MAX(usage_events.prompt_tokens, excluded.prompt_tokens),
       cache_read_tokens = MAX(usage_events.cache_read_tokens, excluded.cache_read_tokens),
       cache_write_tokens = MAX(usage_events.cache_write_tokens, excluded.cache_write_tokens),
       total_tokens = MAX(usage_events.total_tokens, excluded.total_tokens),
       cost_usd = CASE
           WHEN excluded.cost_origin = 'api' THEN excluded.cost_usd
           WHEN usage_events.cost_origin = 'api' THEN usage_events.cost_usd
           ELSE COALESCE(excluded.cost_usd, usage_events.cost_usd)
       END,
       cost_origin = CASE
           WHEN excluded.cost_origin = 'api' THEN 'api'
           WHEN usage_events.cost_origin = 'api' THEN 'api'
           ELSE excluded.cost_origin
       END`,
    rows,
  );
}

export function upsertAdmin(db: Database, rows: UsageEventRow[]): number {
  return runInsert(
    db,
    `INSERT INTO usage_events ${COLS} ${VALS}
     ON CONFLICT(source, source_message_id) DO UPDATE SET
       prompt_tokens = excluded.prompt_tokens,
       completion_tokens = excluded.completion_tokens,
       total_tokens = excluded.total_tokens,
       cost_usd = excluded.cost_usd,
       cost_origin = 'api'`,
    rows,
  );
}

const AGG_COLS =
  "COUNT(*) AS requests, COALESCE(SUM(prompt_tokens),0) AS prompt, COALESCE(SUM(completion_tokens),0) AS completion, COALESCE(SUM(total_tokens),0) AS total, COALESCE(SUM(cost_usd),0.0) AS cost";

export function windowUsage(
  db: Database,
  startMs: number,
  nextResetMs: number,
  sources: string[],
  provider?: string,
): UsageAggregate {
  if (sources.length === 0) return { requests: 0, prompt: 0, completion: 0, total: 0, cost: 0 };
  const placeholders = sources.map(() => "?").join(",");
  const provClause = provider !== undefined ? " AND provider = ?" : "";
  const sql = `SELECT ${AGG_COLS} FROM usage_events
    WHERE timestamp_ms >= ? AND timestamp_ms < ? AND source IN (${placeholders})${provClause}`;
  const args: (string | number)[] = [startMs, nextResetMs, ...sources];
  if (provider !== undefined) args.push(provider);
  return db.query(sql).get(...args) as UsageAggregate;
}

export function todaysTotals(db: Database, nowMs: number): UsageAggregate {
  const start = nowMs - (nowMs % 86_400_000);
  const next = start + 86_400_000;
  const sql = `SELECT ${AGG_COLS} FROM usage_events WHERE timestamp_ms >= ? AND timestamp_ms < ?`;
  return db.query(sql).get(start, next) as UsageAggregate;
}
