/**
 * Normalized live-usage model. Mirrors the shape oh-my-pi exposes
 * (provider → account → limit, each with a real window and amount).
 * Port of the Rust `usage` model.
 */
export type UsageUnit = "percent" | "tokens" | "requests" | "usd" | "minutes" | "bytes" | "unknown";
export type UsageStatus = "ok" | "warning" | "exhausted" | "unknown";

export function unitShort(u: UsageUnit): string {
  const map: Record<UsageUnit, string> = {
    percent: "%",
    tokens: "tok",
    requests: "req",
    usd: "$",
    minutes: "min",
    bytes: "B",
    unknown: "",
  };
  return map[u];
}

export interface UsageWindow {
  id: string;
  label: string;
  durationMs?: number;
  /** Epoch ms when this window resets. */
  resetsAt?: number;
}

export interface UsageAmount {
  used?: number;
  limit?: number;
  remaining?: number;
  usedFraction?: number;
  remainingFraction?: number;
  unit: UsageUnit;
}

export interface UsageScope {
  provider: string;
  accountId?: string;
  projectId?: string;
  orgId?: string;
  modelId?: string;
  tier?: string;
  windowId?: string;
  shared: boolean;
}

export interface UsageLimit {
  id: string;
  label: string;
  tier?: string;
  scope: UsageScope;
  window?: UsageWindow;
  amount: UsageAmount;
  status: UsageStatus;
  notes: string[];
}

/** One provider account's resolved usage at fetch time. */
export interface UsageReport {
  provider: string;
  account: string;
  fetchedAt: number;
  limits: UsageLimit[];
  notes: string[];
}

/** Status from a used fraction: >=1 exhausted, >=0.9 warning, else ok;
 * undefined fraction => unknown. Port of Rust `providers/zai.rs`. */
export function statusOf(usedFraction: number | undefined): UsageStatus {
  if (usedFraction === undefined) return "unknown";
  if (usedFraction >= 1) return "exhausted";
  if (usedFraction >= 0.9) return "warning";
  return "ok";
}

/** Provider ids atop can fetch live usage for (the 12 fetchers). Shared by
 * `usage/fetcher.ts::supported()` and `auth/store.ts::allProviders()`. */
export const SUPPORTED_PROVIDERS: string[] = [
  "zai",
  "anthropic",
  "github-copilot",
  "google-antigravity",
  "google-gemini-cli",
  "openai-codex",
  "kimi-code",
  "minimax-code",
  "minimax-code-cn",
  "opencode-go",
  "ollama",
  "xai-oauth",
];
