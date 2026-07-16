/**
 * Anthropic (Claude Pro/Max) usage fetcher — OAuth.
 * GET https://api.anthropic.com/api/oauth/usage
 * Required headers: Authorization Bearer, anthropic-beta: oauth-2025-04-20,
 * User-Agent: claude-code/2.0.0 (mandatory — wrong UA causes persistent 429).
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

const ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const ANTHROPIC_BETA = "oauth-2025-04-20";

interface Bucket {
  utilization?: number;
  resets_at?: string;
}

interface UsageResponse {
  five_hour?: Bucket;
  seven_day?: Bucket;
  seven_day_opus?: Bucket;
  seven_day_sonnet?: Bucket;
  email?: string;
  account_id?: string;
}

function parseIso(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
}

function amount(util: number | undefined): UsageAmount | undefined {
  if (util === undefined) return undefined;
  const clamped = Math.max(0, Math.min(100, util));
  const frac = clamped / 100;
  return {
    used: clamped,
    limit: 100,
    remaining: Math.max(0, 100 - clamped),
    usedFraction: frac,
    remainingFraction: Math.max(0, 1 - frac),
    unit: "percent" satisfies UsageUnit,
  };
}

interface LimitSpec {
  id: string;
  label: string;
  windowId: string;
  windowLabel: string;
  durationMs: number;
  tier: string | undefined;
}

function buildLimit(spec: LimitSpec, bucket: Bucket | undefined): UsageLimit | undefined {
  if (!bucket) return undefined;
  const amt = amount(bucket.utilization);
  if (!amt) return undefined;
  const scope: UsageScope = {
    provider: "anthropic",
    accountId: undefined,
    projectId: undefined,
    orgId: undefined,
    modelId: undefined,
    tier: spec.tier,
    windowId: spec.windowId,
    shared: spec.tier === undefined,
  };
  const window: UsageWindow = {
    id: spec.windowId,
    label: spec.windowLabel,
    durationMs: spec.durationMs,
    resetsAt: parseIso(bucket.resets_at),
  };
  return {
    id: spec.id,
    label: spec.label,
    tier: spec.tier,
    scope,
    window,
    amount: amt,
    status: statusOf(amt.usedFraction),
    notes: [],
  };
}

function parse(body: UsageResponse): UsageLimit[] {
  const specs: Array<[LimitSpec, Bucket | undefined]> = [
    [
      { id: "anthropic:5h", label: "Claude 5 Hour", windowId: "5h", windowLabel: "5 Hour", durationMs: FIVE_HOURS_MS, tier: undefined },
      body.five_hour,
    ],
    [
      { id: "anthropic:7d", label: "Claude 7 Day", windowId: "7d", windowLabel: "7 Day", durationMs: SEVEN_DAYS_MS, tier: undefined },
      body.seven_day,
    ],
    [
      { id: "anthropic:7d:opus", label: "Claude 7 Day (Opus)", windowId: "7d", windowLabel: "7 Day", durationMs: SEVEN_DAYS_MS, tier: "opus" },
      body.seven_day_opus,
    ],
    [
      { id: "anthropic:7d:sonnet", label: "Claude 7 Day (Sonnet)", windowId: "7d", windowLabel: "7 Day", durationMs: SEVEN_DAYS_MS, tier: "sonnet" },
      body.seven_day_sonnet,
    ],
  ];
  return specs.flatMap(([spec, bucket]) => {
    const out = buildLimit(spec, bucket);
    return out ? [out] : [];
  });
}

export const anthropicFetcher: UsageFetcher = {
  provider: "anthropic",
  async fetch(cred: Credential, _db: Database): Promise<UsageReport | null> {
    if (cred.type !== "oauth") return null;
    const token = cred.access;
    const resp = await sendRetry(ENDPOINT, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json, text/plain, */*",
        "anthropic-beta": ANTHROPIC_BETA,
        "content-type": "application/json",
        "user-agent": "claude-code/2.0.0",
      },
    });
    if (!resp.ok) throw new Error(`anthropic usage HTTP ${resp.status}`);
    const body = (await resp.json()) as UsageResponse;
    const limits = parse(body);
    if (limits.length === 0) return null;
    const account =
      cred.email ?? body.email ?? cred.account_id ?? body.account_id ?? "account";
    return {
      provider: "anthropic",
      account,
      fetchedAt: Date.now(),
      limits,
      notes: [],
    };
  },
};