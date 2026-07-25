/**
 * xAI (Grok) OAuth usage fetcher.
 *
 * Reads utilization from the Grok CLI billing endpoint. Prefer the legacy
 * weekly `?format=credits` payload (creditUsagePercent / productUsage). When
 * xAI marks the account as unified billing and omits those fields, fall back
 * to the default monthly included-quota shape (monthlyLimit / used). Only OAuth
 * access credentials are accepted; paid API keys are a separate product and
 * must never be sent here. Port of `oh-my-pi/packages/ai/src/usage/xai-oauth.ts`.
 */
import type { Database } from "bun:sqlite";
import {
  buildXaiCliBillingUrl,
  extractXaiAccessTokenSubject,
  fetchXaiOAuthIdentity,
  getXaiCliBillingHeaders,
} from "../../auth/oauth/xai.ts";
import {
  type UsageAmount,
  type UsageLimit,
  type UsageReport,
  type UsageWindow,
  statusOf,
} from "../types.ts";
import type { Credential } from "../../auth/types.ts";
import type { UsageFetcher } from "../fetcher.ts";

const PROVIDER_ID = "xai-oauth";
const BILLING_TIMEOUT_MS = 20_000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const PRODUCT_LABELS: Record<string, string> = { GrokBuild: "Grok Build", Api: "API" };

interface XaiBillingPeriod {
  start: string;
  end: string;
  type: string;
}

interface XaiProductUsage {
  product: string;
  usagePercent: number;
}

interface XaiWeeklyBillingConfig {
  kind: "weekly";
  currentPeriod: XaiBillingPeriod;
  creditUsagePercent: number;
  productUsage: XaiProductUsage[];
  onDemandCap?: number;
  onDemandUsed?: number;
}

interface XaiMonthlyBillingConfig {
  kind: "monthly";
  periodStart: string;
  periodEnd: string;
  used: number;
  limit: number;
  onDemandCap?: number;
  onDemandUsed?: number;
}

type XaiBillingConfig = XaiWeeklyBillingConfig | XaiMonthlyBillingConfig;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function parseIsoMs(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parsePercent(value: unknown): number | undefined {
  const percent = toNumber(value);
  return percent !== undefined && percent >= 0 && percent <= 100 ? percent : undefined;
}

function parseMoneyVal(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const amount = toNumber(value.val);
  return amount !== undefined && amount >= 0 ? amount : undefined;
}

function percentAmount(usagePercent: number): UsageAmount {
  const usedFraction = usagePercent / 100;
  return {
    used: usagePercent,
    limit: 100,
    remaining: 100 - usagePercent,
    usedFraction,
    remainingFraction: 1 - usedFraction,
    unit: "percent",
  };
}

function scopeFor(windowId: string | undefined, accountId: string | undefined) {
  return {
    provider: PROVIDER_ID,
    ...(accountId ? { accountId } : {}),
    ...(windowId ? { windowId } : {}),
    shared: true as const,
  };
}

function buildPeriodWindow(period: XaiBillingPeriod): UsageWindow {
  return { id: "1w", label: "Weekly", durationMs: WEEK_MS, resetsAt: parseIsoMs(period.end) };
}

function buildMonthlyWindow(periodStart: string, periodEnd: string): UsageWindow | undefined {
  const startMs = parseIsoMs(periodStart);
  const endMs = parseIsoMs(periodEnd);
  if (startMs === undefined || endMs === undefined || endMs <= startMs) return undefined;
  const durationMs = endMs - startMs;
  const approxDays = Math.max(1, Math.round(durationMs / DAY_MS));
  return {
    id: "1mo",
    label: approxDays === 30 || approxDays === 31 ? "Monthly" : `${approxDays}d`,
    durationMs,
    resetsAt: endMs,
  };
}

/**
 * Parse the legacy SuperGrok weekly `?format=credits` config. Keeps a just-ended
 * weekly window so usage still renders across period rollover; rejects only
 * inverted ranges and non-weekly period types.
 */
export function parseWeeklyBillingConfig(raw: Record<string, unknown>): XaiWeeklyBillingConfig | null {
  if (!isRecord(raw.currentPeriod)) return null;
  const start = typeof raw.currentPeriod.start === "string" ? parseIsoMs(raw.currentPeriod.start) : undefined;
  const end = typeof raw.currentPeriod.end === "string" ? parseIsoMs(raw.currentPeriod.end) : undefined;
  const type = typeof raw.currentPeriod.type === "string" ? raw.currentPeriod.type : "";
  if (start === undefined || end === undefined || end <= start || !type.toUpperCase().includes("WEEK")) {
    return null;
  }
  const creditUsagePercent = parsePercent(raw.creditUsagePercent);
  if (creditUsagePercent === undefined) return null;
  const productUsage: XaiProductUsage[] = [];
  if (raw.productUsage !== undefined) {
    if (!Array.isArray(raw.productUsage)) return null;
    for (const item of raw.productUsage) {
      if (!isRecord(item)) continue;
      const product = typeof item.product === "string" ? item.product.trim() : "";
      const usagePercent = parsePercent(item.usagePercent);
      if (!product || usagePercent === undefined) continue;
      productUsage.push({ product, usagePercent });
    }
  }
  return {
    kind: "weekly",
    currentPeriod: { start: raw.currentPeriod.start as string, end: raw.currentPeriod.end as string, type },
    creditUsagePercent,
    productUsage,
    onDemandCap: parseMoneyVal(raw.onDemandCap),
    onDemandUsed: parseMoneyVal(raw.onDemandUsed),
  };
}

/** Parse the unified-billing monthly included-quota config. */
export function parseMonthlyBillingConfig(raw: Record<string, unknown>): XaiMonthlyBillingConfig | null {
  const periodStart = typeof raw.billingPeriodStart === "string" ? raw.billingPeriodStart : "";
  const periodEnd = typeof raw.billingPeriodEnd === "string" ? raw.billingPeriodEnd : "";
  const startMs = parseIsoMs(periodStart);
  const endMs = parseIsoMs(periodEnd);
  if (!periodStart || !periodEnd || startMs === undefined || endMs === undefined || endMs <= startMs) {
    return null;
  }
  const limit = parseMoneyVal(raw.monthlyLimit);
  const used = parseMoneyVal(raw.used);
  if (limit === undefined || limit <= 0 || used === undefined) return null;
  return {
    kind: "monthly",
    periodStart,
    periodEnd,
    used,
    limit,
    onDemandCap: parseMoneyVal(raw.onDemandCap),
    onDemandUsed: parseMoneyVal(raw.onDemandUsed),
  };
}

function buildOnDemandLimit(
  onDemandCap: number | undefined,
  onDemandUsed: number | undefined,
  accountId: string | undefined,
): UsageLimit | undefined {
  if (onDemandCap === undefined || onDemandCap <= 0 || onDemandUsed === undefined) return undefined;
  const usedFraction = Math.min(onDemandUsed / onDemandCap, 1);
  return {
    id: `${PROVIDER_ID}:on-demand`,
    label: "On-demand",
    scope: scopeFor(undefined, accountId),
    amount: {
      used: onDemandUsed,
      limit: onDemandCap,
      remaining: Math.max(0, onDemandCap - onDemandUsed),
      usedFraction,
      remainingFraction: 1 - usedFraction,
      unit: "unknown",
    },
    status: statusOf(usedFraction),
    notes: [],
  };
}

function slugifyProduct(product: string): string {
  return product
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function buildLimits(config: XaiBillingConfig, accountId: string | undefined): UsageLimit[] {
  if (config.kind === "weekly") {
    const window = buildPeriodWindow(config.currentPeriod);
    const scope = scopeFor(window.id, accountId);
    const overall = percentAmount(config.creditUsagePercent);
    const limits: UsageLimit[] = [
      {
        id: `${PROVIDER_ID}:credits:1w`,
        label: "SuperGrok Weekly Credits",
        scope,
        window,
        amount: overall,
        status: statusOf(overall.usedFraction),
        notes: [],
      },
    ];
    for (const item of config.productUsage) {
      const slug = slugifyProduct(item.product);
      if (!slug) continue;
      const amount = percentAmount(item.usagePercent);
      limits.push({
        id: `${PROVIDER_ID}:product:${slug}:1w`,
        label: `${PRODUCT_LABELS[item.product] ?? item.product} (Weekly)`,
        scope,
        window,
        amount,
        status: statusOf(amount.usedFraction),
        notes: [],
      });
    }
    const onDemand = buildOnDemandLimit(config.onDemandCap, config.onDemandUsed, accountId);
    if (onDemand) limits.push(onDemand);
    return limits;
  }

  const window = buildMonthlyWindow(config.periodStart, config.periodEnd);
  if (!window) return [];
  const usedFraction = Math.min(config.used / config.limit, 1);
  const limits: UsageLimit[] = [
    {
      id: `${PROVIDER_ID}:included:1mo`,
      label: "SuperGrok Monthly Included",
      scope: scopeFor(window.id, accountId),
      window,
      amount: {
        used: config.used,
        limit: config.limit,
        remaining: Math.max(0, config.limit - config.used),
        usedFraction,
        remainingFraction: 1 - usedFraction,
        unit: "unknown",
      },
      status: statusOf(usedFraction),
      notes: [],
    },
  ];
  const onDemand = buildOnDemandLimit(config.onDemandCap, config.onDemandUsed, accountId);
  if (onDemand) limits.push(onDemand);
  return limits;
}

async function fetchBillingPayload(url: string, accessToken: string): Promise<unknown | null> {
  try {
    const resp = await fetch(url, {
      headers: getXaiCliBillingHeaders(accessToken),
      redirect: "error",
      signal: AbortSignal.timeout(BILLING_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

function configOf(payload: unknown): Record<string, unknown> | null {
  return isRecord(payload) && isRecord(payload.config) ? payload.config : null;
}

export const xaiOauthFetcher: UsageFetcher = {
  provider: PROVIDER_ID,
  async fetch(cred: Credential, _db: Database): Promise<UsageReport | null> {
    if (cred.type !== "oauth") return null;
    const accessToken = cred.access.trim();
    if (!accessToken) return null;
    if (cred.expires != null && cred.expires <= Date.now()) return null;

    let accountId = cred.account_id?.trim() || extractXaiAccessTokenSubject(accessToken);
    let email = cred.email?.trim().toLowerCase();
    if (!email) {
      const identity = await fetchXaiOAuthIdentity(accessToken);
      email = identity?.email?.trim().toLowerCase() || undefined;
      accountId ??= identity?.accountId?.trim() || undefined;
    }

    const creditsUrl = buildXaiCliBillingUrl();
    const monthlyUrl = buildXaiCliBillingUrl("");
    const creditsPayload = await fetchBillingPayload(creditsUrl, accessToken);
    const creditsConfig = configOf(creditsPayload);
    const weekly = creditsConfig ? parseWeeklyBillingConfig(creditsConfig) : null;
    const creditsLooksUnified = creditsConfig?.isUnifiedBillingUser === true;

    let monthly: XaiMonthlyBillingConfig | null = null;
    const shouldProbeMonthly = (!weekly || creditsLooksUnified) && monthlyUrl !== creditsUrl;
    if (shouldProbeMonthly) {
      const monthlyConfig = configOf(await fetchBillingPayload(monthlyUrl, accessToken));
      monthly = monthlyConfig ? parseMonthlyBillingConfig(monthlyConfig) : null;
    }

    if (!weekly && !monthly) return null;

    const limits: UsageLimit[] = [];
    if (weekly) limits.push(...buildLimits(weekly, accountId));
    if (monthly) limits.push(...buildLimits(monthly, accountId));
    const seen = new Set<string>();
    const deduped: UsageLimit[] = [];
    for (const limit of limits) {
      if (!seen.has(limit.id)) {
        seen.add(limit.id);
        deduped.push(limit);
      }
    }
    if (deduped.length === 0) return null;

    return {
      provider: PROVIDER_ID,
      account: email ?? accountId ?? "account",
      fetchedAt: Date.now(),
      limits: deduped,
      notes: [],
    };
  },
};

