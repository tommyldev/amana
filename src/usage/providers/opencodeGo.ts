/**
 * OpenCode Go usage fetcher. Unlike the others, this is *local* — it reads
 * cost rows from the OMP sqlite (windowUsage over rolling-5h / weekly / monthly)
 * rather than calling an external API. The limits are illustrative (price
 * values from the source): they're a way to see OpenCode Go spend in the TUI
 * for events already ingested locally.
 */
import type { Database } from "bun:sqlite";
import { windowUsage } from "../../db/usage.ts";
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

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const LIMITS: Array<[string, string, number, number]> = [
  ["rolling-5h", "5 Hour limit", 5 * HOUR_MS, 12],
  ["weekly", "Weekly limit", 7 * DAY_MS, 30],
  ["monthly", "Monthly limit", 30 * DAY_MS, 60],
];

function statusOf(usedFraction: number | undefined): UsageStatus {
  if (usedFraction === undefined) return "unknown";
  if (usedFraction >= 1) return "exhausted";
  if (usedFraction >= 0.8) return "warning";
  return "ok";
}

export const opencodeGoFetcher: UsageFetcher = {
  provider: "opencode-go",
  async fetch(cred: Credential, db: Database): Promise<UsageReport | null> {
    const now = Date.now();
    const sources = ["omp"];
    const limits: UsageLimit[] = [];
    for (const [id, label, durationMs, limitUsd] of LIMITS) {
      const agg = windowUsage(db, now - durationMs, now + 1, sources, "opencode-go");
      const used = agg.cost;
      const usedFraction = limitUsd > 0 ? Math.max(0, Math.min(1, used / limitUsd)) : undefined;
      const scope: UsageScope = {
        provider: "opencode-go",
        accountId: cred.type === "api_key" ? (cred.account ?? "api key") : (cred.email ?? cred.account_id ?? "account"),
        projectId: undefined,
        orgId: undefined,
        modelId: undefined,
        tier: "OpenCode Go",
        windowId: id,
        shared: true,
      };
      const window: UsageWindow = {
        id,
        label: label.replace(" limit", ""),
        durationMs,
        resetsAt: now + durationMs,
      };
      const amount: UsageAmount = {
        used,
        limit: limitUsd,
        remaining: Math.max(0, limitUsd - used),
        usedFraction,
        remainingFraction: usedFraction === undefined ? undefined : Math.max(0, 1 - usedFraction),
        unit: "usd" satisfies UsageUnit,
      };
      limits.push({
        id,
        label,
        tier: "OpenCode Go",
        scope,
        window,
        amount,
        status: statusOf(usedFraction),
        notes: [],
      });
    }
    const account = cred.type === "api_key" ? (cred.account ?? "api key") : (cred.email ?? cred.account_id ?? "account");
    return {
      provider: "opencode-go",
      account,
      fetchedAt: now,
      limits,
      notes: ["OMP-observed spend only; OpenCode usage outside OMP is not included."],
    };
  },
};