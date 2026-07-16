/**
 * xAI (Grok) OAuth usage fetcher.
 * GET https://cli-chat-proxy.grok.com/v1/billing
 * Header `x-xai-token-auth: xai-grok-cli` is required alongside Bearer.
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

const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing";

interface MoneyVal {
  val?: number;
}

interface BillingCycle {
  billingPeriodEnd?: string;
}

interface UsageSummary {
  totalUsed?: MoneyVal;
}

interface BillingResponse {
  billingCycle?: BillingCycle;
  monthlyLimit?: MoneyVal;
  usage?: UsageSummary;
}

function statusOf(usedFraction: number | undefined): UsageStatus {
  if (usedFraction === undefined) return "unknown";
  if (usedFraction >= 1) return "exhausted";
  if (usedFraction >= 0.9) return "warning";
  return "ok";
}

export const xaiOauthFetcher: UsageFetcher = {
  provider: "xai-oauth",
  async fetch(cred: Credential, _db: Database): Promise<UsageReport | null> {
    if (cred.type !== "oauth") return null;
    const body = (await httpJson(BILLING_URL, {
      headers: {
        authorization: `Bearer ${cred.access}`,
        "x-xai-token-auth": "xai-grok-cli",
        accept: "application/json",
      },
    })) as BillingResponse;
    const usedCents = body.usage?.totalUsed?.val !== undefined ? body.usage!.totalUsed!.val! / 100 : undefined;
    const limitCents = body.monthlyLimit?.val !== undefined ? body.monthlyLimit!.val! / 100 : undefined;
    const usedFraction =
      usedCents !== undefined && limitCents !== undefined && limitCents > 0
        ? Math.max(0, Math.min(1, usedCents / limitCents))
        : undefined;
    const resetsAt = body.billingCycle?.billingPeriodEnd
      ? (() => {
          const t = Date.parse(body.billingCycle!.billingPeriodEnd!);
          return Number.isFinite(t) ? t : undefined;
        })()
      : undefined;
    if (usedFraction === undefined && usedCents === undefined && limitCents === undefined) return null;
    const remaining =
      usedCents !== undefined && limitCents !== undefined ? Math.max(0, limitCents - usedCents) : undefined;
    const scope: UsageScope = {
      provider: "xai-oauth",
      accountId: cred.account_id,
      projectId: undefined,
      orgId: undefined,
      modelId: undefined,
      tier: undefined,
      windowId: "monthly",
      shared: true,
    };
    const window: UsageWindow = { id: "monthly", label: "Monthly", durationMs: undefined, resetsAt };
    const amount: UsageAmount = {
      used: usedCents,
      limit: limitCents,
      remaining,
      usedFraction,
      remainingFraction: usedFraction === undefined ? undefined : Math.max(0, 1 - usedFraction),
      unit: "usd" satisfies UsageUnit,
    };
    const limit: UsageLimit = {
      id: "xai-oauth:monthly",
      label: "Grok Credits",
      tier: undefined,
      scope,
      window,
      amount,
      status: statusOf(usedFraction),
      notes: ["Undocumented Grok CLI billing endpoint"],
    };
    return {
      provider: "xai-oauth",
      account: cred.email ?? cred.account_id ?? "account",
      fetchedAt: Date.now(),
      limits: [limit],
      notes: [],
    };
  },
};