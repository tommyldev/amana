/**
 * omp (oh-my-pi) JSONL ingestion. Mirrors source/omp/mod.rs +
 * source/omp/parse.rs: only assistant messages with a usage block become
 * rows; token fields come from usage.{input,output,cacheRead,cache_write};
 * cost from usage.cost.total; timestamp accepts an int epoch-ms or an
 * RFC 3339 string. cost_origin is "logged".
 */
import type { Database } from "bun:sqlite";
import type { UsageEventRow } from "../db/types.ts";
import { ompDir } from "../config/paths.ts";
import { insertEvents } from "../db/usage.ts";
import { ensureProvider } from "../db/providers.ts";
import { collectJsonlFiles, resetCursor, tailFile } from "./scan.ts";

interface OmpEntry {
  type?: string;
  id?: string;
  message?: OmpMsg;
}
interface OmpMsg {
  role?: string;
  model?: string;
  provider?: string;
  usage?: OmpUsage;
  timestamp?: number | string;
}
interface OmpUsage {
  input?: number;
  output?: number;
  /** Accept both the camelCase form (common in omp logs) and snake_case. */
  cacheRead?: number;
  cache_read?: number;
  cacheWrite?: number;
  cache_write?: number;
  cost?: { total?: number };
}

/** Parse one omp JSONL line into a UsageEventRow, or null to skip. */
export function parseOmpLine(line: string): UsageEventRow | null {
  let entry: OmpEntry;
  try {
    entry = JSON.parse(line) as OmpEntry;
  } catch {
    return null;
  }
  if (entry.type !== "message") return null;
  const msg = entry.message;
  if (!msg || msg.role !== "assistant") return null;
  const id = entry.id;
  const usage = msg.usage;
  if (!id || !usage) return null;
  const prompt = usage.input ?? 0;
  const completion = usage.output ?? 0;
  const cacheRead = usage.cacheRead ?? usage.cache_read ?? 0;
  const cacheWrite = usage.cacheWrite ?? usage.cache_write ?? 0;
  const total = prompt + completion + cacheRead + cacheWrite;
  const cost = usage.cost?.total ?? null;
  const provider = msg.provider ?? "unknown";
  const model = msg.model ?? "unknown";
  let ts = Date.now();
  if (typeof msg.timestamp === "number") ts = msg.timestamp;
  else if (typeof msg.timestamp === "string") {
    if (/^-?\d+$/.test(msg.timestamp)) ts = Number(msg.timestamp);
    else {
      const ms = Date.parse(msg.timestamp);
      if (Number.isFinite(ms)) ts = ms;
    }
  }
  return {
    source: "omp",
    source_message_id: id,
    timestamp_ms: ts,
    provider,
    model,
    prompt_tokens: prompt,
    completion_tokens: completion,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    total_tokens: total,
    cost_usd: cost,
    cost_origin: "logged",
  };
}

/**
 * Ingest all new omp session lines. Returns inserted count + status.
 * `full=true` resets the per-file cursor so every line is re-read.
 */
export async function ingestOmp(
  db: Database,
  full: boolean,
): Promise<{ inserted: number; status: string }> {
  const root = ompDir();
  ensureProvider(db, "omp", "oh-my-pi (omp) logs", "LogOmp");
  const files = await collectJsonlFiles(root);
  if (files.length === 0) return { inserted: 0, status: "no data" };
  if (full) resetCursor(db, "omp", files);
  let total = 0;
  for (const path of files) {
    const { rows } = await tailFile(db, "omp", path, parseOmpLine);
    if (rows.length > 0) total += insertEvents(db, rows);
  }
  return { inserted: total, status: "ok" };
}
