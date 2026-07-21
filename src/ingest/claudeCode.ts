/**
 * Claude Code JSONL ingestion. Mirrors source/claude_code/mod.rs +
 * source/claude_code/parse.rs: only assistant messages with usage become
 * rows; token fields come from usage.{input_tokens,output_tokens,
 * cache_read_input_tokens,cache_creation_input_tokens}; cost is computed
 * via price.cost; provider is "anthropic" when model starts with "claude",
 * else "unknown"; cost_origin is "computed". The cursor short-circuits when
 * stored mtime matches file mtime, matching the Rust fast-path.
 */
import type { Database } from "bun:sqlite";
import type { UsageEventRow } from "../db/types.ts";
import { claudeDir } from "../config/paths.ts";
import { insertEventsDedupCompletion } from "../db/usage.ts";
import { ensureProvider } from "../db/providers.ts";
import { setSync } from "../db/syncState.ts";
import { cost } from "../price.ts";
import { collectJsonlFiles, resetCursor, tailFile } from "./scan.ts";

interface CcEntry {
  type?: string;
  uuid?: string;
  timestamp?: string;
  message?: CcMsg;
}
interface CcMsg {
  role?: string;
  model?: string;
  usage?: CcUsage;
}
interface CcUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Parse one Claude Code JSONL line into a UsageEventRow, or null to skip. */
export function parseClaudeCodeLine(line: string): UsageEventRow | null {
  let entry: CcEntry;
  try {
    entry = JSON.parse(line) as CcEntry;
  } catch {
    return null;
  }
  if (entry.type !== "assistant") return null;
  const msg = entry.message;
  if (!msg || msg.role !== "assistant") return null;
  const usage = msg.usage;
  const uuid = entry.uuid;
  if (!usage || !uuid) return null;
  const model = msg.model ?? "unknown";
  const prompt = usage.input_tokens ?? 0;
  const completion = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const total = prompt + completion + cacheRead + cacheWrite;
  const promptU = prompt > 0 ? prompt : 0;
  const completionU = completion > 0 ? completion : 0;
  const computedCost = cost(model, promptU, completionU, cacheRead, cacheWrite);
  let ts = Date.now();
  if (typeof entry.timestamp === "string") {
    if (/^-?\d+$/.test(entry.timestamp)) ts = Number(entry.timestamp);
    else {
      const ms = Date.parse(entry.timestamp);
      if (Number.isFinite(ms)) ts = ms;
    }
  }
  return {
    source: "claude-code",
    source_message_id: uuid,
    timestamp_ms: ts,
    provider: model.startsWith("claude") ? "anthropic" : "unknown",
    model,
    prompt_tokens: prompt,
    completion_tokens: completion,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    total_tokens: total,
    cost_usd: computedCost ?? null,
    cost_origin: "computed",
  };
}

/**
 * Ingest all new Claude Code project lines. Returns inserted count + status.
 * `full=true` resets the per-file cursor so every line is re-read.
 */
export async function ingestClaudeCode(
  db: Database,
  full: boolean,
): Promise<{ inserted: number; status: string }> {
  const root = claudeDir();
  ensureProvider(db, "claude-code", "Claude Code logs", "LogClaudeCode");
  const files = await collectJsonlFiles(root);
  if (files.length === 0) return { inserted: 0, status: "no data" };
  if (full) resetCursor(db, "claude-code", files);
  let total = 0;
  for (const path of files) {
    const { rows, changed, newOffset, mtimeMs } = await tailFile(db, "claude-code", path, parseClaudeCodeLine);
    if (!changed) continue;
    if (rows.length > 0) total += insertEventsDedupCompletion(db, rows);
    setSync(db, "claude-code", path, newOffset, mtimeMs);
  }
  return { inserted: total, status: "ok" };
}