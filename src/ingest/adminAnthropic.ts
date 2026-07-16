/**
 * Anthropic admin (organization usage) ingestion. Mirrors
 * source/admin_anthropic.rs: pulls a 35-day, day-bucketed usage feed from
 * the organization usage API and upserts via db.upsertAdmin. `cost_origin`
 * is "api". Token counts come from each result row; `amount` is the cost.
 *
 * Caller (sync.ts) resolves the admin key from the credential store.
 */
import type { Database } from "bun:sqlite";
import type { UsageEventRow } from "../db/types.ts";
import { upsertAdmin } from "../db/usage.ts";
import { setProviderStatus } from "../db/providers.ts";

interface UsageEntry {
  model: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  amount?: number;
}
interface UsageBucket {
  start_time: number;
  results: UsageEntry[];
}
interface UsageResponse {
  data: UsageBucket[];
}

/** Convert a UsageResponse into one UsageEventRow per (bucket, model). */
export function parseAdminAnthropic(body: UsageResponse, provider = "anthropic"): UsageEventRow[] {
  const out: UsageEventRow[] = [];
  for (const bucket of body.data) {
    const tsMs = bucket.start_time * 1000;
    for (const entry of bucket.results) {
      const input = entry.input_tokens ?? 0;
      const output = entry.output_tokens ?? 0;
      const cacheRead = entry.cache_read_input_tokens ?? 0;
      const cacheWrite = entry.cache_creation_input_tokens ?? 0;
      out.push({
        source: "anthropic-api",
        source_message_id: `admin:${provider}:${bucket.start_time}:${entry.model}`,
        timestamp_ms: tsMs,
        provider,
        model: entry.model,
        prompt_tokens: input,
        completion_tokens: output,
        cache_read_tokens: cacheRead,
        cache_write_tokens: cacheWrite,
        total_tokens: input + output + cacheRead + cacheWrite,
        cost_usd: entry.amount ?? null,
        cost_origin: "api",
      });
    }
  }
  return out;
}

/** Fetch the last 35 days of org usage and upsert. */
export async function ingestAdminAnthropic(
  db: Database,
  apiKey: string,
): Promise<{ inserted: number; status: string }> {
  const nowSec = Math.floor(Date.now() / 1000);
  const startSec = nowSec - 35 * 86_400;
  const url =
    `https://api.anthropic.com/v1/organizations/usage` +
    `?start_time=${startSec}&end_time=${nowSec}&bucket_width=1d`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    const status = `error: network ${(e as Error).message}`;
    setProviderStatus(db, "anthropic-api", status);
    return { inserted: 0, status };
  }
  if (!resp.ok) {
    const status = `error: http ${resp.status}`;
    setProviderStatus(db, "anthropic-api", status);
    return { inserted: 0, status };
  }
  const body = (await resp.json()) as UsageResponse;
  const rows = parseAdminAnthropic(body);
  const inserted = upsertAdmin(db, rows);
  setProviderStatus(db, "anthropic-api", "ok");
  return { inserted, status: "ok" };
}