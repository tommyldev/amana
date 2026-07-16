/**
 * MiniMax / MiniMax-CN usage fetcher — api_key OR oauth (Bearer).
 * GET {api.minimax.io|api.minimaxi.com}/v1/token_plan/remains
 *   Authorization: Bearer <token|key>
 * Maps current_interval_* → 5h, current_weekly_* → 7d.
 * current_weekly_status == 0 suppresses the weekly window entirely.
 *
 * The Rust source only accepts api_key credentials; this port honors the
 * Phase-4 spec which authorizes both oauth and api_key Bearer tokens.
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

const GLOBAL_BASE = "https://api.minimax.io";
const CN_BASE = "https://api.minimaxi.com";
const PATH = "/v1/token_plan/remains";
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

interface ModelRemain {
  model_name?: string;
  current_interval_total_count?: number;
  current_interval_usage_count?: number;
  current_interval_remaining_percent?: number;
  end_time?: number;
  current_weekly_status?: number;
  current_weekly_total_count?: number;
  current_weekly_usage_count?: number;
  current_weekly_remaining_percent?: number;
  weekly_end_time?: number;
}

interface BaseResp {
  status_code?: number;
  status_msg?: string;
}

interface ResponseBody {
  base_resp?: BaseResp;
  model_remains?: ModelRemain[];
}

function normalizeEpochMs(ts: number | undefined): number | undefined {
  if (ts === undefined) return undefined;
  return Math.abs(ts) > 10_000_000_000 ? ts : ts * 1000;
}

function statusOf(usedFraction: number | undefined): UsageStatus {
  if (usedFraction === undefined) return "unknown";
  if (usedFraction >= 1) return "exhausted";
  if (usedFraction >= 0.9) return "warning";
  return "ok";
}

function buildWindowLimit(
  provider: string,
  account: string,
  modelName: string | undefined,
  windowId: string,
  label: string,
  durationMs: number,
  total: number | undefined,
  usageCount: number | undefined,
  remainingPercent: number | undefined,
  resetTime: number | undefined,
): UsageLimit | undefined {
  const remainingFraction = remainingPercent === undefined ? undefined : Math.max(0, Math.min(1, remainingPercent / 100));
  let usedFraction: number | undefined;
  if (remainingFraction !== undefined) {
    usedFraction = 1 - remainingFraction;
  } else if (total !== undefined && usageCount !== undefined && total > 0) {
    usedFraction = Math.max(0, Math.min(1, (total - usageCount) / total));
  }
  if (usedFraction === undefined && remainingFraction === undefined) return undefined;
  const used =
    total !== undefined && usageCount !== undefined
      ? Math.max(0, total - usageCount)
      : usedFraction === undefined
      ? undefined
      : usedFraction * 100;
  const limit = total ?? (usedFraction === undefined ? undefined : 100);
  const remaining =
    total !== undefined && usageCount !== undefined
      ? Math.max(0, usageCount)
      : remainingFraction === undefined
      ? undefined
      : remainingFraction * 100;
  const scope: UsageScope = {
    provider,
    accountId: account,
    projectId: undefined,
    orgId: undefined,
    modelId: modelName,
    tier: undefined,
    windowId,
    shared: true,
  };
  const window: UsageWindow = {
    id: windowId,
    label: windowId === "5h" ? "5 Hour" : "7 Day",
    durationMs,
    resetsAt: normalizeEpochMs(resetTime),
  };
  const amount: UsageAmount = {
    used,
    limit,
    remaining,
    usedFraction,
    remainingFraction,
    unit: (total !== undefined ? "requests" : "percent") satisfies UsageUnit,
  };
  return { id: `${provider}:${windowId}`, label, tier: undefined, scope, window, amount, status: statusOf(usedFraction), notes: [] };
}

function parseModels(provider: string, rows: ModelRemain[], account: string): UsageLimit[] {
  const representative = rows.find(
    (r) =>
      r.current_interval_remaining_percent !== undefined ||
      r.current_weekly_remaining_percent !== undefined ||
      r.current_interval_total_count !== undefined,
  );
  if (!representative) return [];
  const limits: UsageLimit[] = [];
  const five = buildWindowLimit(
    provider,
    account,
    representative.model_name,
    "5h",
    "MiniMax 5 Hour",
    FIVE_HOURS_MS,
    representative.current_interval_total_count,
    representative.current_interval_usage_count,
    representative.current_interval_remaining_percent,
    representative.end_time,
  );
  if (five) limits.push(five);
  const wStatus = representative.current_weekly_status ?? 1;
  // 0 = no weekly plan, 3 = unlimited → emit no weekly limit; 2 = exhausted.
  if (wStatus !== 0 && wStatus !== 3) {
    const weekly = buildWindowLimit(
      provider,
      account,
      representative.model_name,
      "7d",
      "MiniMax 7 Day",
      SEVEN_DAYS_MS,
      representative.current_weekly_total_count,
      representative.current_weekly_usage_count,
      representative.current_weekly_remaining_percent,
      representative.weekly_end_time,
    );
    if (weekly) {
      if (wStatus === 2) weekly.status = "exhausted";
      limits.push(weekly);
    }
  }
  return limits;
}

async function fetchFor(provider: string, base: string, cred: Credential, _db: Database): Promise<UsageReport | null> {
  const bearer = cred.type === "api_key" ? cred.key : cred.access;
  const body = (await httpJson(`${base}${PATH}`, {
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      accept: "application/json",
    },
  })) as ResponseBody;
  const baseResp = body.base_resp;
  if (baseResp && (baseResp.status_code ?? 0) !== 0) {
    throw new Error(baseResp.status_msg ?? `${provider} usage status ${baseResp.status_code ?? -1}`);
  }
  const account = cred.type === "api_key" ? (cred.account ?? "api key") : (cred.email ?? cred.account_id ?? "account");
  const limits = parseModels(provider, body.model_remains ?? [], account);
  if (limits.length === 0) return null;
  return { provider, account, fetchedAt: Date.now(), limits, notes: [] };
}

export const minimaxFetcher: UsageFetcher = {
  provider: "minimax-code",
  async fetch(cred: Credential, db: Database): Promise<UsageReport | null> {
    return fetchFor("minimax-code", GLOBAL_BASE, cred, db);
  },
};

export const minimaxCnFetcher: UsageFetcher = {
  provider: "minimax-code-cn",
  async fetch(cred: Credential, db: Database): Promise<UsageReport | null> {
    return fetchFor("minimax-code-cn", CN_BASE, cred, db);
  },
};