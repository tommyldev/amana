/**
 * OpenAI admin (organization costs) ingestion. Mirrors
 * source/admin_openai.rs: pulls a 35-day window of day-bucketed model cost
 * totals from the organization costs API and upserts them via
 * db.upsertAdmin. `cost_origin` is "api"; tokens are zero (the costs
 * endpoint does not return token counts).
 *
 * Caller (sync.ts) is responsible for resolving the api key from the
 * credential store; this module only consumes the string.
 */
import type { Database } from "bun:sqlite";
import type { UsageEventRow } from "../db/types.ts";
import { upsertAdmin } from "../db/usage.ts";
import { setProviderStatus } from "../db/providers.ts";

const DAY_MS = 86_400_000;

interface CostBucket {
  start_time: number;
  results: Record<string, number>;
}
interface CostsResponse {
  data: CostBucket[];
  has_more?: boolean;
}

/** Convert a CostsResponse into one UsageEventRow per (bucket, model). */
export function parseAdminOpenai(body: CostsResponse, provider = "openai"): UsageEventRow[] {
  const out: UsageEventRow[] = [];
  for (const bucket of body.data) {
    const tsMs = bucket.start_time * 1000;
    for (const [model, amount] of Object.entries(bucket.results)) {
      out.push({
        source: "openai-api",
        source_message_id: `admin:${provider}:${bucket.start_time}:${model}`,
        timestamp_ms: tsMs,
        provider,
        model,
        prompt_tokens: 0,
        completion_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        total_tokens: 0,
        cost_usd: amount,
        cost_origin: "api",
      });
    }
  }
  return out;
}

/**
 * Fetch the last 35 days of organization costs and upsert. `apiKey` is the
 * admin/org key already resolved by the caller.
 */
export async function ingestAdminOpenai(
  db: Database,
  apiKey: string,
): Promise<{ inserted: number; status: string }> {
  const nowSec = Math.floor(Date.now() / 1000);
  const startSec = nowSec - 35 * 86_400;
  const url =
    `https://api.openai.com/v1/organization/costs` +
    `?start_time=${startSec}&end_time=${nowSec}&limit=1000&group_by[]=model`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    const status = `error: network ${(e as Error).message}`;
    setProviderStatus(db, "openai-api", status);
    return { inserted: 0, status };
  }
  if (!resp.ok) {
    const status = `error: http ${resp.status}`;
    setProviderStatus(db, "openai-api", status);
    return { inserted: 0, status };
  }
  const body = (await resp.json()) as CostsResponse;
  const rows = parseAdminOpenai(body);
  const inserted = upsertAdmin(db, rows);
  setProviderStatus(db, "openai-api", "ok");
  // Mark ts so the orchestrator can return the same status string.
  void DAY_MS;
  return { inserted, status: "ok" };
}