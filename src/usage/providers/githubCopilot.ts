/**
 * GitHub Copilot usage fetcher — API key or OAuth.
 * GET {base}/copilot_internal/user
 * Surfaces premium_interactions, chat, completions snapshots. Unlimited
 * buckets are omitted; overage_count becomes a note.
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

const DEFAULT_API = "https://api.github.com";

interface CopilotQuotaDetail {
  entitlement: number;
  remaining: number;
  unlimited?: boolean;
  overage_count?: number;
}

interface CopilotQuotaSnapshots {
  premium_interactions?: CopilotQuotaDetail;
  chat?: CopilotQuotaDetail;
  completions?: CopilotQuotaDetail;
}

interface CopilotUsageResponse {
  copilot_plan?: string;
  quota_reset_date?: string;
  quota_reset_date_utc?: string;
  quota_snapshots?: CopilotQuotaSnapshots;
}

function parseWindow(reset: string | undefined): UsageWindow | undefined {
  if (!reset) return undefined;
  const ts = Date.parse(reset);
  if (!Number.isFinite(ts)) return undefined;
  return { id: "monthly", label: "Monthly", durationMs: undefined, resetsAt: ts };
}

function statusOf(usedFraction: number | undefined, unlimited: boolean): UsageStatus {
  if (unlimited) return "ok";
  if (usedFraction === undefined) return "unknown";
  if (usedFraction >= 1) return "exhausted";
  if (usedFraction >= 0.9) return "warning";
  return "ok";
}

function buildLimit(
  key: string,
  label: string,
  account: string,
  plan: string | undefined,
  window: UsageWindow | undefined,
  quota: CopilotQuotaDetail,
): UsageLimit {
  const used = quota.unlimited ? undefined : Math.max(0, quota.entitlement - quota.remaining);
  const limit = quota.unlimited ? undefined : quota.entitlement;
  const usedFraction = !quota.unlimited && used !== undefined && limit !== undefined && limit > 0
    ? Math.max(0, Math.min(1, used / limit))
    : undefined;
  const remaining = !quota.unlimited && used !== undefined && limit !== undefined
    ? Math.max(0, limit - used)
    : undefined;
  const notes =
    quota.overage_count !== undefined && quota.overage_count > 0
      ? [`Overage requests: ${Math.trunc(quota.overage_count)}`]
      : [];
  const scope: UsageScope = {
    provider: "github-copilot",
    accountId: account,
    projectId: undefined,
    orgId: undefined,
    modelId: undefined,
    tier: plan,
    windowId: "monthly",
    shared: true,
  };
  const amount: UsageAmount = {
    used,
    limit,
    remaining,
    usedFraction,
    remainingFraction: usedFraction === undefined ? undefined : Math.max(0, 1 - usedFraction),
    unit: "requests" satisfies UsageUnit,
  };
  return {
    id: `github-copilot:${key}`,
    label,
    tier: plan,
    scope,
    window: window ? { ...window } : undefined,
    amount,
    status: statusOf(usedFraction, quota.unlimited ?? false),
    notes,
  };
}

export const githubCopilotFetcher: UsageFetcher = {
  provider: "github-copilot",
  async fetch(cred: Credential, _db: Database): Promise<UsageReport | null> {
    const token = cred.type === "api_key" ? cred.key : cred.access;
    const account = cred.type === "api_key" ? (cred.account ?? "api key") : (cred.email ?? cred.account_id ?? "account");
    const enterprise = cred.enterprise_url;
    const base = (enterprise ?? DEFAULT_API).replace(/\/$/, "");
    const resp = await fetch(`${base}/copilot_internal/user`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "x-github-api-version": "2025-04-01",
      },
    });
    if (!resp.ok) throw new Error(`github-copilot usage HTTP ${resp.status}`);
    const body = (await resp.json()) as CopilotUsageResponse;
    const window = parseWindow(body.quota_reset_date ?? body.quota_reset_date_utc);
    const plan = body.copilot_plan;
    const limits: UsageLimit[] = [];
    const snap = body.quota_snapshots;
    if (snap?.premium_interactions) {
      limits.push(buildLimit("premium", "Premium Requests", account, plan, window, snap.premium_interactions));
    }
    if (snap?.chat && !snap.chat.unlimited) {
      limits.push(buildLimit("chat", "Chat Requests", account, plan, window, snap.chat));
    }
    if (snap?.completions && !snap.completions.unlimited) {
      limits.push(buildLimit("completions", "Completions", account, plan, window, snap.completions));
    }
    if (limits.length === 0) return null;
    return { provider: "github-copilot", account, fetchedAt: Date.now(), limits, notes: [] };
  },
};