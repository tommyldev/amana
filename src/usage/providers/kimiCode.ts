/**
 * Kimi Code usage fetcher — OAuth.
 * GET {base}/usages with Bearer access token.
 */
import type { Database } from "bun:sqlite";
import { httpJson } from "../http.ts";
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

const DEFAULT_BASE_URL = "https://api.kimi.com/coding/v1";

interface KimiUsage {
  limit?: number;
  remaining?: number;
  resetTime?: string;
}

interface KimiLimit {
  detail?: KimiUsage;
  window?: KimiWindow;
  name?: string;
}

interface KimiWindow {
  duration?: number;
  timeUnit?: string;
}

interface KimiUsagePayload {
  usage?: KimiUsage;
  limits?: KimiLimit[];
}

function parseTime(value: string): number | undefined {
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : undefined;
}

function windowLabel(window: KimiWindow): string | undefined {
  const duration = window.duration;
  const unit = window.timeUnit?.toUpperCase();
  if (duration === undefined || unit === undefined) return undefined;
  if (unit.includes("MINUTE")) {
    return duration >= 60 && duration % 60 === 0 ? `${duration / 60} Hour` : `${duration} Minute`;
  }
  if (unit.includes("HOUR")) return `${duration} Hour`;
  if (unit.includes("DAY")) return `${duration} Day`;
  return undefined;
}

function windowDurationMs(window: KimiWindow): number | undefined {
  const duration = window.duration;
  const unit = window.timeUnit?.toUpperCase();
  if (duration === undefined || unit === undefined) return undefined;
  if (unit.includes("MINUTE")) return duration * 60_000;
  if (unit.includes("HOUR")) return duration * 3_600_000;
  if (unit.includes("DAY")) return duration * 86_400_000;
  return undefined;
}

function statusOf(usedFraction: number | undefined): UsageStatus {
  if (usedFraction === undefined) return "unknown";
  if (usedFraction >= 1) return "exhausted";
  if (usedFraction >= 0.9) return "warning";
  return "ok";
}

function buildLimit(
  id: string,
  label: string,
  detail: KimiUsage,
  window: KimiWindow | undefined,
  accountId: string | undefined,
): UsageLimit | undefined {
  const limit = detail.limit;
  const remaining = detail.remaining;
  const used = limit !== undefined && remaining !== undefined ? Math.max(0, limit - remaining) : undefined;
  const usedFraction =
    used !== undefined && limit !== undefined && limit > 0
      ? Math.max(0, Math.min(1, used / limit))
      : undefined;
  if (limit === undefined && usedFraction === undefined) return undefined;
  const resetsAt = detail.resetTime !== undefined ? parseTime(detail.resetTime) : undefined;
  const usageWindow: UsageWindow | undefined = window
    ? {
        id: "window",
        label: windowLabel(window) ?? "Usage window",
        durationMs: windowDurationMs(window),
        resetsAt,
      }
    : resetsAt !== undefined
    ? { id: "window", label: "Usage window", durationMs: undefined, resetsAt }
    : undefined;
  const scope: UsageScope = {
    provider: "kimi-code",
    accountId,
    projectId: undefined,
    orgId: undefined,
    modelId: undefined,
    tier: undefined,
    windowId: usageWindow?.id,
    shared: true,
  };
  const amount: UsageAmount = {
    used,
    limit,
    remaining,
    usedFraction,
    remainingFraction: usedFraction === undefined ? undefined : Math.max(0, 1 - usedFraction),
    unit: "unknown" satisfies UsageUnit,
  };
  return { id, label, tier: undefined, scope, window: usageWindow, amount, status: statusOf(usedFraction), notes: [] };
}

export const kimiCodeFetcher: UsageFetcher = {
  provider: "kimi-code",
  async fetch(cred: Credential, _db: Database): Promise<UsageReport | null> {
    if (cred.type !== "oauth") return null;
    const base = (cred.enterprise_url ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    const body = (await httpJson(`${base}/usages`, {
      headers: {
        authorization: `Bearer ${cred.access}`,
        accept: "application/json",
      },
    })) as KimiUsagePayload;
    const limits: UsageLimit[] = [];
    if (body.usage) {
      const summary = buildLimit("kimi-code:summary", "Total quota", body.usage, undefined, cred.account_id);
      if (summary) limits.push(summary);
    }
    for (let idx = 0; idx < (body.limits ?? []).length; idx++) {
      const limit = body.limits![idx];
      if (!limit.detail) continue;
      const row = buildLimit(`kimi-code:${idx}`, limit.name ?? "Usage window", limit.detail, limit.window, cred.account_id);
      if (row) limits.push(row);
    }
    if (limits.length === 0) return null;
    return {
      provider: "kimi-code",
      account: cred.email ?? cred.account_id ?? "account",
      fetchedAt: Date.now(),
      limits,
      notes: [],
    };
  },
};