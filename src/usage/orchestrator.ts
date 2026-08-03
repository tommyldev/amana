/**
 * Orchestrates live usage fetches: walks atop's stored credentials for each
 * supported provider, refreshes expired OAuth tokens, and returns the union of
 * UsageReports plus a per-credential error log (so the UI can show *why* a
 * provider is empty instead of looking blank). Port of `orchestrator.rs`.
 */
import type { Database } from "bun:sqlite";
import type { Credential } from "../auth/types.ts";
import type { UsageReport } from "./types.ts";
import { accountLabel, needsRefresh } from "../auth/types.ts";
import { allProviders, load, upsert } from "../auth/store.ts";
import { fetcherFor } from "./fetcher.ts";
import { refresh as anthropicRefresh } from "../auth/oauth/anthropic.ts";
import { refresh as googleRefresh } from "../auth/oauth/google.ts";
import { refresh as openaiCodexRefresh } from "../auth/oauth/openaiCodex.ts";
import { refresh as minimaxRefresh } from "../auth/oauth/minimax.ts";
import { refresh as kimiRefresh } from "../auth/oauth/kimi.ts";
import { refresh as xaiRefresh } from "../auth/oauth/xai.ts";
import { refresh as opencodeRefresh } from "../auth/oauth/opencode.ts";

export interface FetchError {
  provider: string;
  account: string;
  message: string;
}

export interface FetchResult {
  reports: UsageReport[];
  errors: FetchError[];
}

function refreshFor(provider: string): ((cred: Credential) => Promise<Credential>) | undefined {
  switch (provider) {
    case "anthropic":
      return anthropicRefresh;
    case "google-antigravity":
    case "google-gemini-cli":
      return googleRefresh;
    case "openai-codex":
      return openaiCodexRefresh;
    case "minimax-code":
    case "minimax-code-cn":
      return minimaxRefresh;
    case "kimi-code":
      return kimiRefresh;
    case "xai-oauth":
      return xaiRefresh;
    case "opencode-go":
      return opencodeRefresh;
    default:
      return undefined;
  }
}

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Fetch live usage for every credential atop has stored for the given
 * providers (default: all providers with stored credentials). A single failed
 * credential never blocks the others.
 */
export async function fetchAll(
  db: Database,
  dataDir: string,
  opts?: { provider?: string },
): Promise<FetchResult> {
  const providers = opts?.provider ? [opts.provider] : allProviders(dataDir);
  const errors: FetchError[] = [];
  const pending: Promise<UsageReport | null>[] = [];
  const now = Date.now();

  for (const provider of providers) {
    for (const original of load(dataDir, provider)) {
      let cred = original;
      if (needsRefresh(cred, now) && cred.type === "oauth" && cred.refresh) {
        const doRefresh = refreshFor(provider);
        if (doRefresh) {
          try {
            cred = await doRefresh(cred);
            upsert(dataDir, provider, cred);
          } catch (e) {
            errors.push({ provider, account: accountLabel(original), message: errMessage(e) });
            continue;
          }
        }
      }
      const account = accountLabel(cred);
      const fetcher = fetcherFor(provider);
      if (!fetcher) {
        errors.push({ provider, account, message: "no fetcher registered for this provider" });
        continue;
      }
      pending.push(
        fetcher.fetch(cred, db).then((report) => {
          if (report === null) throw new Error("provider returned no usage data");
          return report;
        }).catch((e) => {
          errors.push({ provider, account, message: errMessage(e) });
          return null;
        }),
      );
    }
  }

  const settled = await Promise.all(pending);
  const reports = settled.filter((r): r is UsageReport => r !== null);
  return { reports, errors };
}

/** Per-provider freshest report (used by the TUI). */
export function freshest(reports: UsageReport[]): Map<string, UsageReport> {
  const by = new Map<string, UsageReport>();
  for (const r of reports) {
    const prev = by.get(r.provider);
    if (!prev || prev.fetchedAt < r.fetchedAt) by.set(r.provider, r);
  }
  return by;
}
