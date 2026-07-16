/**
 * Google Antigravity usage fetcher — OAuth.
 * POST {endpoint}/v1internal:fetchAvailableModels
 * Returns a map of models keyed by name, each carrying quota_info / quota_infos.
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

interface QuotaInfo {
  remainingFraction?: number;
  resetTime?: string;
  tier?: string;
  windowId?: string;
  windowLabel?: string;
  apiProvider?: string;
  modelProvider?: string;
}

interface ModelInfo {
  quota_info?: QuotaInfo;
  quota_infos?: QuotaInfo[];
  api_provider?: string;
  model_provider?: string;
}

interface ModelsResponse {
  models?: Record<string, ModelInfo>;
}

function counterName(info: QuotaInfo): string {
  const provider = info.modelProvider ?? info.apiProvider;
  switch (provider) {
    case "MODEL_PROVIDER_ANTHROPIC":
    case "API_PROVIDER_ANTHROPIC_VERTEX":
      return "Anthropic";
    case "MODEL_PROVIDER_OPENAI":
    case "API_PROVIDER_OPENAI_VERTEX":
      return "OpenAI";
    case "MODEL_PROVIDER_GOOGLE":
    case "API_PROVIDER_GOOGLE_GEMINI":
      return "Google";
    default:
      return "Default";
  }
}

function parseWindow(info: QuotaInfo): UsageWindow | undefined {
  const reset = info.resetTime;
  if (!reset) return undefined;
  const ts = Date.parse(reset);
  if (!Number.isFinite(ts)) return undefined;
  return {
    id: info.windowId ?? "default",
    label: info.windowLabel ?? "Default",
    durationMs: undefined,
    resetsAt: ts,
  };
}

function statusOf(remainingFraction: number | undefined): UsageStatus {
  if (remainingFraction === undefined) return "unknown";
  if (remainingFraction <= 0) return "exhausted";
  if (remainingFraction <= 0.1) return "warning";
  return "ok";
}

function buildLimit(
  key: string,
  counter: string,
  info: QuotaInfo,
  window: UsageWindow | undefined,
  accountId: string | undefined,
  projectId: string | undefined,
): UsageLimit {
  const remainingFraction =
    info.remainingFraction !== undefined
      ? Math.max(0, Math.min(1, info.remainingFraction))
      : info.resetTime !== undefined
      ? 0
      : undefined;
  const usedFraction = remainingFraction === undefined ? undefined : Math.max(0, Math.min(1, 1 - remainingFraction));
  const scope: UsageScope = {
    provider: "google-antigravity",
    accountId,
    projectId,
    orgId: undefined,
    modelId: undefined,
    tier: info.tier,
    windowId: info.windowId ?? window?.id,
    shared: true,
  };
  const amount: UsageAmount = {
    used: usedFraction === undefined ? undefined : usedFraction * 100,
    limit: usedFraction === undefined ? undefined : 100,
    remaining: remainingFraction === undefined ? undefined : remainingFraction * 100,
    usedFraction,
    remainingFraction,
    unit: "percent" satisfies UsageUnit,
  };
  return {
    id: `google-antigravity:${key.replace(/\|/g, ":")}`,
    label: `Usage (${counter})`,
    tier: info.tier,
    scope,
    window,
    amount,
    status: statusOf(remainingFraction),
    notes: [],
  };
}

function normalize(
  body: ModelsResponse,
  accountId: string | undefined,
  projectId: string | undefined,
): UsageLimit[] {
  const deduped = new Map<string, { info: QuotaInfo; window: UsageWindow | undefined; counter: string }>();
  for (const model of Object.values(body.models ?? {})) {
    const infos: QuotaInfo[] = [];
    if (model.quota_info) infos.push(model.quota_info);
    if (model.quota_infos) infos.push(...model.quota_infos);
    for (const raw of infos) {
      const info: QuotaInfo = { ...raw };
      if (info.apiProvider === undefined) info.apiProvider = model.api_provider;
      if (info.modelProvider === undefined) info.modelProvider = model.model_provider;
      const counter = counterName(info);
      const tier = (info.tier ?? "default").toLowerCase();
      const windowId = info.windowId ?? "default";
      const key = `${counter.toLowerCase()}|${tier}|${windowId}`;
      const window = parseWindow(info);
      const prev = deduped.get(key);
      if (prev) {
        const curr = info.remainingFraction ?? 0;
        const old = prev.info.remainingFraction ?? 1;
        if (curr < old) deduped.set(key, { info, window, counter });
      } else {
        deduped.set(key, { info, window, counter });
      }
    }
  }
  const limits = Array.from(deduped.entries()).map(([key, v]) =>
    buildLimit(key, v.counter, v.info, v.window, accountId, projectId),
  );
  limits.sort((a, b) => {
    const af = a.amount.remainingFraction ?? 1;
    const bf = b.amount.remainingFraction ?? 1;
    return af - bf;
  });
  return limits;
}

export const googleAntigravityFetcher: UsageFetcher = {
  provider: "google-antigravity",
  async fetch(cred: Credential, _db: Database): Promise<UsageReport | null> {
    if (cred.type !== "oauth") return null;
    const projectId = cred.project_id;
    if (!projectId) throw new Error("google-antigravity credential missing project_id");
    const access = cred.access;
    const endpoint = (cred.enterprise_url ?? DEFAULT_ENDPOINT).replace(/\/$/, "");
    const body = (await httpJson(`${endpoint}/v1internal:fetchAvailableModels`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${access}`,
        "content-type": "application/json",
        "user-agent": "antigravity",
      },
      body: JSON.stringify({ project: projectId }),
    })) as ModelsResponse;
    const limits = normalize(body, cred.account_id, cred.project_id);
    if (limits.length === 0) return null;
    return {
      provider: "google-antigravity",
      account: cred.email ?? cred.account_id ?? cred.project_id ?? "account",
      fetchedAt: Date.now(),
      limits,
      notes: [],
    };
  },
};