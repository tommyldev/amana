/**
 * OpenAI Codex usage fetcher — OAuth (api_key accepted as fallback).
 * GET {base}/wham/usage with Authorization Bearer + (when known) ChatGPT-Account-Id.
 *
 * Tolerates both field spellings observed in production:
 *   rate_limit.primary_window / secondary_window
 *     used_percent, limit_window_seconds, reset_at (ms or s)
 *     -- and the alternate spellings used_percent_left / percent_left,
 *        reset_time_ms / reset_after_seconds -- mapped to the same shape.
 *
 * `reset_at` / `reset_time_ms` is normalized sec-vs-ms by magnitude.
 */
import type { Database } from "bun:sqlite";
import { sendRetry } from "../http.ts";
import {
  type UsageAmount,
  type UsageLimit,
  type UsageReport,
  type UsageScope,
  type UsageStatus,
  type UsageUnit,
  type UsageWindow,
} from "../types.ts";
import type { Credential } from "../../auth/types.ts";
import type { UsageFetcher } from "../fetcher.ts";

const DEFAULT_BASE = "https://chatgpt.com/backend-api";

export interface WindowPayload {
  /** Direct percent remaining. */
  used_percent?: number;
  /** Alternate spelling observed in production: percent remaining (0-100). */
  percent_left?: number;
  /** Window duration in seconds (some payloads). */
  limit_window_seconds?: number;
  /** Reset time as ms epoch (preferred). */
  reset_at?: number;
  /** Reset time as ms epoch (alternate). */
  reset_time_ms?: number;
  /** Seconds-from-now fallback. */
  reset_after_seconds?: number;
}

export interface RateLimitPayload {
  limit_reached?: boolean;
  primary_window?: WindowPayload;
  secondary_window?: WindowPayload;
}

export interface UsagePayload {
  plan_type?: string;
  rate_limit?: RateLimitPayload;
  rate_limits?: UsagePayload;
}

/** Normalize a possibly-sec, possibly-ms epoch to ms. */
export function normalizeEpochMs(ts: number): number {
  if (Math.abs(ts) > 1_000_000_000_000) return ts;
  return ts * 1000;
}

/** Map a codex window payload to usedFraction (0-1) and reset ms. Exported for tests. */
export function normalizeWindow(
  w: WindowPayload | undefined,
  nowMs: number,
): { usedFraction?: number; resetsAt?: number; durationMs?: number } {
  if (!w) return {};
  let usedFraction: number | undefined;
  if (w.used_percent !== undefined) {
    usedFraction = Math.max(0, Math.min(1, w.used_percent / 100));
  } else if (w.percent_left !== undefined) {
    usedFraction = Math.max(0, Math.min(1, (100 - w.percent_left) / 100));
  }
  let resetsAt: number | undefined;
  if (w.reset_at !== undefined) {
    resetsAt = normalizeEpochMs(w.reset_at);
  } else if (w.reset_time_ms !== undefined) {
    resetsAt = normalizeEpochMs(w.reset_time_ms);
  } else if (w.reset_after_seconds !== undefined) {
    resetsAt = nowMs + w.reset_after_seconds * 1000;
  }
  const durationMs = w.limit_window_seconds !== undefined ? w.limit_window_seconds * 1000 : undefined;
  return { usedFraction, resetsAt, durationMs };
}

function buildLimit(
  key: string,
  window: WindowPayload,
  limitReached: boolean,
  planType: string | undefined,
  accountId: string | undefined,
  nowMs: number,
): UsageLimit {
  const { usedFraction, resetsAt, durationMs } = normalizeWindow(window, nowMs);
  const label = key === "primary" ? "Primary window" : "Secondary window";
  const usageWindow: UsageWindow = {
    id: key,
    label,
    durationMs,
    resetsAt,
  };
  const scope: UsageScope = {
    provider: "openai-codex",
    accountId,
    projectId: undefined,
    orgId: undefined,
    modelId: undefined,
    tier: planType,
    windowId: key,
    shared: true,
  };
  const amount: UsageAmount = {
    used: usedFraction === undefined ? undefined : usedFraction * 100,
    limit: 100,
    remaining: usedFraction === undefined ? undefined : Math.max(0, 1 - usedFraction) * 100,
    usedFraction,
    remainingFraction: usedFraction === undefined ? undefined : Math.max(0, 1 - usedFraction),
    unit: "percent" satisfies UsageUnit,
  };
  let status: UsageStatus;
  if (limitReached) {
    status = "exhausted";
  } else if (usedFraction === undefined) {
    status = "unknown";
  } else if (usedFraction >= 1) {
    status = "exhausted";
  } else if (usedFraction >= 0.9) {
    status = "warning";
  } else {
    status = "ok";
  }
  return {
    id: `openai-codex:${key}`,
    label,
    tier: planType,
    scope,
    window: usageWindow,
    amount,
    status,
    notes: [],
  };
}

export const openaiCodexFetcher: UsageFetcher = {
  provider: "openai-codex",
  async fetch(cred: Credential, _db: Database): Promise<UsageReport | null> {
    const access = cred.type === "oauth" ? cred.access : cred.key;
    const accountId = cred.type === "oauth" ? cred.account_id : cred.account;
    const email = cred.type === "oauth" ? cred.email : undefined;
    const enterprise = cred.enterprise_url;
    const base = (enterprise ?? DEFAULT_BASE).replace(/\/$/, "");
    const headers: Record<string, string> = {
      authorization: `Bearer ${access}`,
      "user-agent": "OpenCode-Status-Plugin/1.0",
    };
    if (accountId) headers["ChatGPT-Account-Id"] = accountId;
    const resp = await sendRetry(`${base}/wham/usage`, { headers });
    if (!resp.ok) throw new Error(`openai-codex usage HTTP ${resp.status}`);
    const body = (await resp.json()) as UsagePayload;
    const payload = body.rate_limits ?? body;
    const rate = payload.rate_limit;
    if (!rate) return null;
    const limitReached = rate.limit_reached ?? false;
    const nowMs = Date.now();
    const limits: UsageLimit[] = [];
    if (rate.primary_window) {
      limits.push(buildLimit("primary", rate.primary_window, limitReached, payload.plan_type, accountId, nowMs));
    }
    if (rate.secondary_window) {
      limits.push(buildLimit("secondary", rate.secondary_window, limitReached, payload.plan_type, accountId, nowMs));
    }
    if (limits.length === 0) return null;
    const account =
      email ?? accountId ?? (cred.type === "api_key" ? (cred.account ?? "api key") : "account");
    return { provider: "openai-codex", account, fetchedAt: nowMs, limits, notes: [] };
  },
};