import { existsSync, mkdirSync, renameSync, writeFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { launchCacheFile } from "../config/paths.ts";
import type { ProviderHourly } from "../db/types.ts";
import type { UsageReport } from "../usage/types.ts";
import type { FetchError } from "../usage/orchestrator.ts";
import type { AccountRow } from "./state.ts";
import type { OverviewRow } from "./views/derive.ts";
import type { LimitRow } from "./views/limitRows.ts";
import type { SpanWindow } from "./spans.ts";

export interface LaunchCache {
  savedAt: number;
  spanId: string;
  spanWindow: SpanWindow;
  overviewRows: OverviewRow[];
  limitRows: LimitRow[];
  reports: UsageReport[];
  errors: FetchError[];
  tokenSeries: ProviderHourly[];
  totalSeries: number[];
  accounts: AccountRow[];
}

function looksValid(parsed: unknown): parsed is LaunchCache {
  if (typeof parsed !== "object" || parsed === null) return false;
  const p = parsed as Record<string, unknown>;
  return typeof p.spanId === "string" && Array.isArray(p.totalSeries) && Array.isArray(p.overviewRows);
}

/** Load the last-session cache, or null if missing/corrupt. */
export function readLaunchCache(dataDir: string): LaunchCache | null {
  try {
    const file = launchCacheFile(dataDir);
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return looksValid(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Atomically persist the session so the next launch paints before any network. */
export function writeLaunchCache(dataDir: string, cache: LaunchCache): void {
  try {
    const file = launchCacheFile(dataDir);
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 });
    renameSync(tmp, file);
  } catch (e) {
    console.error("[Agent Mana] launch cache write failed:", e instanceof Error ? e.message : e);
  }
}
