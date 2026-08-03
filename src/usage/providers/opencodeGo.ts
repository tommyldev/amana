/**
 * OpenCode Go usage fetcher.
 *
 * Two credential paths, because the OpenCode console API only accepts OAuth
 * bearer tokens:
 *
 * - OAuth credentials call `GET /api/go/status` on console.opencode.ai and map
 *   its micro-cents meters (five_hour / calendar_week / product_period) onto
 *   TUI limit rows, so plan quota is real.
 * - API keys can't authenticate the console API (401), so they keep the local
 *   fallback: OMP-observed spend from the sqlite windowUsage tables, with
 *   illustrative limits from the OpenCode Go pricing page. A note nudges the
 *   user toward the OAuth login for real quota.
 */
import type { Database } from "bun:sqlite";
import {
  OPENCODE_CONSOLE_BASE,
  OPENCODE_GO_STATUS_PATH,
  opencodeConsoleHeaders,
} from "../../auth/oauth/opencode.ts";
import { windowUsage } from "../../db/usage.ts";
import type { Credential } from "../../auth/types.ts";
import type { UsageFetcher } from "../fetcher.ts";
import {
  type UsageAmount,
  type UsageLimit,
  type UsageReport,
  type UsageScope,
  type UsageUnit,
  type UsageWindow,
  statusOf,
} from "../types.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const STATUS_TIMEOUT_MS = 20_000;
/** Console API amounts are micro-cents: 1 USD = 1e8. */
const MICRO_CENTS_PER_USD = 1e8;

const LIMITS: Array<[string, string, number, number]> = [
  ["rolling-5h", "5 Hour limit", 5 * HOUR_MS, 12],
  ["weekly", "Weekly limit", 7 * DAY_MS, 30],
  ["monthly", "Monthly limit", 30 * DAY_MS, 60],
];

interface MeterKindSpec {
  windowId: string;
  windowLabel: string;
  limitLabel: string;
  nominalDurationMs: number;
}

const METER_KINDS: Record<string, MeterKindSpec> = {
  five_hour: {
    windowId: "rolling-5h",
    windowLabel: "5 Hour",
    limitLabel: "5 Hour limit",
    nominalDurationMs: 5 * HOUR_MS,
  },
  calendar_week: {
    windowId: "weekly",
    windowLabel: "Weekly",
    limitLabel: "Weekly limit",
    nominalDurationMs: 7 * DAY_MS,
  },
  product_period: {
    windowId: "monthly",
    windowLabel: "Monthly",
    limitLabel: "Monthly limit",
    nominalDurationMs: 30 * DAY_MS,
  },
};

type OAuthCred = Extract<Credential, { type: "oauth" }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Epoch ms from an ISO-8601 string or numeric epoch; undefined when absent. */
function toEpochMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : ms;
  }
  return undefined;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function humanizeKind(kind: string): string {
  return kind.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

interface GoMeter {
  kind?: string;
  windowStartsAt?: number;
  resetsAt?: number;
  limitMicroCents?: number;
  settledMicroCents?: number;
  reservedMicroCents?: number;
  remainingMicroCents?: number;
}

function parseMeter(raw: unknown): GoMeter | null {
  if (!isRecord(raw)) return null;
  return {
    kind: typeof raw.kind === "string" ? raw.kind : undefined,
    windowStartsAt: toEpochMs(raw.windowStartsAt),
    resetsAt: toEpochMs(raw.resetsAt),
    limitMicroCents: toFiniteNumber(raw.limitMicroCents),
    settledMicroCents: toFiniteNumber(raw.settledMicroCents),
    reservedMicroCents: toFiniteNumber(raw.reservedMicroCents),
    remainingMicroCents: toFiniteNumber(raw.remainingMicroCents),
  };
}

function meterToLimit(meter: GoMeter, index: number, accountId: string | undefined): UsageLimit {
  const spec = meter.kind !== undefined ? METER_KINDS[meter.kind] : undefined;
  const windowId = spec?.windowId ?? `meter-${index}`;
  const windowLabel = spec?.windowLabel ?? (meter.kind !== undefined ? humanizeKind(meter.kind) : `Meter ${index + 1}`);
  const limitLabel = spec?.limitLabel ?? `${windowLabel} limit`;

  const used = ((meter.settledMicroCents ?? 0) + (meter.reservedMicroCents ?? 0)) / MICRO_CENTS_PER_USD;
  const limit = (meter.limitMicroCents ?? 0) / MICRO_CENTS_PER_USD;
  const remaining = (meter.remainingMicroCents ?? 0) / MICRO_CENTS_PER_USD;
  const usedFraction = limit > 0 ? clamp01(used / limit) : undefined;
  const remainingFraction = usedFraction === undefined ? undefined : clamp01(1 - usedFraction);

  const derivedDurationMs =
    meter.windowStartsAt !== undefined && meter.resetsAt !== undefined
      ? meter.resetsAt - meter.windowStartsAt
      : undefined;
  const durationMs = derivedDurationMs !== undefined && derivedDurationMs > 0 ? derivedDurationMs : spec?.nominalDurationMs;

  const scope: UsageScope = {
    provider: "opencode-go",
    accountId,
    projectId: undefined,
    orgId: undefined,
    modelId: undefined,
    tier: "OpenCode Go",
    windowId,
    shared: true,
  };
  const window: UsageWindow = { id: windowId, label: windowLabel, durationMs, resetsAt: meter.resetsAt };
  const amount: UsageAmount = {
    used,
    limit,
    remaining,
    usedFraction,
    remainingFraction,
    unit: "usd" satisfies UsageUnit,
  };
  return {
    id: windowId,
    label: limitLabel,
    tier: "OpenCode Go",
    scope,
    window,
    amount,
    status: statusOf(usedFraction),
    notes: [],
  };
}

function statusNotes(payload: Record<string, unknown>): string[] {
  const notes: string[] = [];
  if (typeof payload.subscriptionStatus === "string" && payload.subscriptionStatus !== "") {
    notes.push(`OpenCode Go plan: ${payload.subscriptionStatus}`);
  }
  if (payload.durableBalanceFallbackEnabled === true) {
    notes.push("Durable balance fallback is enabled.");
  }
  return notes.slice(0, 2);
}

async function fetchGoStatus(accessToken: string): Promise<unknown> {
  const resp = await fetch(`${OPENCODE_CONSOLE_BASE}${OPENCODE_GO_STATUS_PATH}`, {
    headers: opencodeConsoleHeaders(accessToken),
    redirect: "error",
    signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const hint = resp.status === 401 ? " — token expired, re-run the OpenCode Go login" : "";
    throw new Error(`OpenCode Go status endpoint returned HTTP ${resp.status}${hint}`);
  }
  return await resp.json();
}

async function oauthReport(cred: OAuthCred, now: number): Promise<UsageReport> {
  const accountId = cred.account_id?.trim() || undefined;
  const payload = await fetchGoStatus(cred.access.trim());
  if (!isRecord(payload)) {
    throw new Error("OpenCode Go status endpoint returned an unexpected response");
  }
  const meters = Array.isArray(payload.meters) ? payload.meters : [];
  const limits: UsageLimit[] = [];
  meters.forEach((raw, index) => {
    const meter = parseMeter(raw);
    if (meter !== null) limits.push(meterToLimit(meter, index, accountId));
  });
  const notes = statusNotes(payload);
  if (meters.length === 0) {
    notes.push("OpenCode Go plan reported no meters.");
  }
  return {
    provider: "opencode-go",
    account: cred.email ?? cred.account_id ?? "account",
    fetchedAt: now,
    limits,
    notes,
  };
}

function localReport(cred: Credential, db: Database, now: number): UsageReport {
  const sources = ["omp"];
  const limits: UsageLimit[] = [];
  for (const [id, label, durationMs, limitUsd] of LIMITS) {
    const agg = windowUsage(db, now - durationMs, now + 1, sources, "opencode-go");
    const used = agg.cost;
    const usedFraction = limitUsd > 0 ? clamp01(used / limitUsd) : undefined;
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
    notes: [
      "OMP-observed spend only; OpenCode usage outside OMP is not included.",
      "Run the OpenCode Go OAuth login for real plan quota.",
    ],
  };
}

export const opencodeGoFetcher: UsageFetcher = {
  provider: "opencode-go",
  async fetch(cred: Credential, db: Database): Promise<UsageReport | null> {
    if (cred.type !== "oauth") return localReport(cred, db, Date.now());
    if (cred.access.trim() === "") return null;
    return oauthReport(cred, Date.now());
  },
};
