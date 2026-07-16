/**
 * Google Gemini CLI usage fetcher — OAuth.
 * POST {base}/v1internal:loadCodeAssist then POST {base}/v1internal:retrieveUserQuota
 * Returns per-model quota buckets with remainingFraction/resetTime.
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

const DEFAULT_ENDPOINT = "https://cloudcode-pa.googleapis.com";

interface LoadCodeAssistResponse {
  cloudaicompanion_project?: unknown;
  current_tier?: { id?: string; name?: string };
}

interface QuotaBucket {
  model_id?: string;
  remaining_fraction?: number;
  reset_time?: string;
}

interface RetrieveUserQuotaResponse {
  buckets?: QuotaBucket[];
}

function extractProjectId(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id: unknown }).id;
    if (typeof id === "string" && id.trim() !== "") return id.trim();
  }
  return undefined;
}

function parseTime(value: string): number | undefined {
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : undefined;
}

function tierFor(model: string): string | undefined {
  const lower = model.toLowerCase();
  if (lower.includes("3-flash")) return "3-Flash";
  if (lower.includes("flash")) return "Flash";
  if (lower.includes("pro")) return "Pro";
  return undefined;
}

function statusOf(remainingFraction: number | undefined): UsageStatus {
  if (remainingFraction === undefined) return "unknown";
  if (remainingFraction <= 0) return "exhausted";
  if (remainingFraction <= 0.1) return "warning";
  return "ok";
}

function buildLimit(
  bucket: QuotaBucket,
  idx: number,
  accountId: string | undefined,
  projectId: string,
): UsageLimit {
  const remainingFraction =
    bucket.remaining_fraction === undefined ? undefined : Math.max(0, Math.min(1, bucket.remaining_fraction));
  const usedFraction = remainingFraction === undefined ? undefined : 1 - remainingFraction;
  const modelId = bucket.model_id ?? "unknown";
  const tier = bucket.model_id ? tierFor(bucket.model_id) : undefined;
  const scope: UsageScope = {
    provider: "google-gemini-cli",
    accountId,
    projectId,
    orgId: undefined,
    modelId: bucket.model_id,
    tier,
    windowId: "quota",
    shared: false,
  };
  const window: UsageWindow = {
    id: "quota",
    label: "Quota window",
    durationMs: undefined,
    resetsAt: bucket.reset_time !== undefined ? parseTime(bucket.reset_time) : undefined,
  };
  const amount: UsageAmount = {
    used: usedFraction === undefined ? undefined : usedFraction * 100,
    limit: 100,
    remaining: remainingFraction === undefined ? undefined : remainingFraction * 100,
    usedFraction,
    remainingFraction,
    unit: "percent" satisfies UsageUnit,
  };
  return {
    id: `google-gemini-cli:${modelId}:${idx}`,
    label: bucket.model_id ? `Gemini ${bucket.model_id}` : "Gemini quota",
    tier,
    scope,
    window,
    amount,
    status: statusOf(remainingFraction),
    notes: [],
  };
}

export const googleGeminiCliFetcher: UsageFetcher = {
  provider: "google-gemini-cli",
  async fetch(cred: Credential, _db: Database): Promise<UsageReport | null> {
    if (cred.type !== "oauth") return null;
    const access = cred.access;
    const base = (cred.enterprise_url ?? DEFAULT_ENDPOINT).replace(/\/$/, "");
    const baseHeaders = {
      authorization: `Bearer ${access}`,
      "content-type": "application/json",
      "user-agent": "GeminiCLI/0.46.0",
      "client-metadata": "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
    };
    const load = (await httpJson(`${base}/v1internal:loadCodeAssist`, {
      method: "POST",
      headers: baseHeaders,
      body: JSON.stringify({
        cloudaicompanionProject: cred.project_id ?? null,
        metadata: {
          ideType: "IDE_UNSPECIFIED",
          platform: "PLATFORM_UNSPECIFIED",
          pluginType: "GEMINI",
        },
      }),
    })) as LoadCodeAssistResponse;
    const projectId = cred.project_id ?? extractProjectId(load.cloudaicompanion_project);
    if (!projectId) throw new Error("google-gemini-cli credential missing project_id");
    const quota = (await httpJson(`${base}/v1internal:retrieveUserQuota`, {
      method: "POST",
      headers: baseHeaders,
      body: JSON.stringify({ project: projectId }),
    })) as RetrieveUserQuotaResponse;
    const limits = (quota.buckets ?? []).map((b, i) => buildLimit(b, i, cred.account_id, projectId));
    if (limits.length === 0) return null;
    const tierName = load.current_tier?.name;
    const notes = tierName ? [tierName] : [];
    return {
      provider: "google-gemini-cli",
      account: cred.email ?? cred.account_id ?? projectId,
      fetchedAt: Date.now(),
      limits,
      notes,
    };
  },
};