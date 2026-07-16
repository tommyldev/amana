/**
 * Z.AI (GLM Coding Plan) usage fetcher — API key.
 * Ports the Rust `zai.rs`:
 *   GET https://api.z.ai/api/monitor/usage/quota/limit
 * Header `Authorization: <key>` (NO Bearer prefix). `nextResetTime` may be
 * seconds or milliseconds (normalized by magnitude).
 */
import type { Database } from "bun:sqlite";
import { sendRetry } from "../http.ts";
import {
  statusOf,
  type UsageAmount,
  type UsageLimit,
  type UsageReport,
  type UsageScope,
  type UsageUnit,
  type UsageWindow,
} from "../types.ts";
import type { Credential } from "../../auth/types.ts";
import type { UsageFetcher } from "../fetcher.ts";

const ENDPOINT = "https://api.z.ai";
const QUOTA_PATH = "/api/monitor/usage/quota/limit";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

interface QuotaPayload {
  success?: boolean;
  data?: { limits?: LimitItem[] };
}

interface LimitItem {
  type?: string;
  usage?: number;
  currentValue?: number;
  percentage?: number;
  remaining?: number;
  nextResetTime?: number;
}

function parseMillis(v: number | undefined): number | undefined {
  if (v === undefined) return undefined;
  return v > 1_000_000_000_000 ? Math.trunc(v) : Math.trunc(v * 1000);
}

function buildAmount(
  used: number | undefined,
  limit: number | undefined,
  remaining: number | undefined,
  percentage: number | undefined,
  unit: UsageUnit,
): UsageAmount {
  let usedFraction: number | undefined;
  if (percentage !== undefined) {
    usedFraction = Math.max(0, Math.min(1, percentage / 100));
  } else if (used !== undefined && limit !== undefined && limit > 0) {
    usedFraction = Math.min(1, used / limit);
  }
  const remainingFraction = usedFraction === undefined ? undefined : Math.max(0, 1 - usedFraction);
  return { used, limit, remaining, usedFraction, remainingFraction, unit };
}

function parseLimits(payload: QuotaPayload): UsageLimit[] {
  if (payload.success !== true) return [];
  const items = payload.data?.limits ?? [];
  const limits: UsageLimit[] = [];
  for (const it of items) {
    const kind = it.type;
    if (kind !== "TOKENS_LIMIT" && kind !== "TIME_LIMIT") continue;
    const id = kind === "TOKENS_LIMIT" ? "zai:tokens" : "zai:requests";
    const label = kind === "TOKENS_LIMIT" ? "ZAI Token Quota" : "ZAI Request Quota";
    const unit: UsageUnit = kind === "TOKENS_LIMIT" ? "tokens" : "requests";
    const window: UsageWindow = {
      id: "quota",
      label: "Quota",
      durationMs: SEVEN_DAYS_MS,
      resetsAt: parseMillis(it.nextResetTime),
    };
    const amount = buildAmount(it.currentValue, it.usage, it.remaining, it.percentage, unit);
    limits.push({
      id,
      label,
      tier: undefined,
      scope: {
        provider: "zai",
        accountId: undefined,
        projectId: undefined,
        orgId: undefined,
        modelId: undefined,
        tier: undefined,
        windowId: "quota",
        shared: true,
      } satisfies UsageScope,
      window,
      amount,
      status: statusOf(amount.usedFraction),
      notes: [],
    });
  }
  return limits;
}

export const zaiFetcher: UsageFetcher = {
  provider: "zai",
  async fetch(cred: Credential, _db: Database): Promise<UsageReport | null> {
    if (cred.type !== "api_key") return null;
    const url = `${ENDPOINT}${QUOTA_PATH}`;
    const resp = await sendRetry(url, {
      headers: {
        authorization: cred.key,
        "content-type": "application/json",
        "user-agent": "OpenCode-Status-Plugin/1.0",
      },
    });
    if (!resp.ok) throw new Error(`zai usage HTTP ${resp.status}`);
    const payload = (await resp.json()) as QuotaPayload;
    const limits = parseLimits(payload);
    if (limits.length === 0) return null;
    return {
      provider: "zai",
      account: cred.account ?? "api key",
      fetchedAt: Date.now(),
      limits,
      notes: [],
    };
  },
};