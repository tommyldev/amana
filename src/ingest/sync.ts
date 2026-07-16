/**
 * Sync orchestrator. Mirrors sync.rs::run_sync: walks the enabled providers
 * from the config and runs each ingestion source at most once per
 * invocation. The LogOmp source runs only for the raw "omp" provider entry
 * (the others are filtered views into already-ingested data, so they skip).
 * LogClaudeCode runs once for "claude-code". AdminOpenAI / AdminAnthropic
 * each fetch their admin key from the credential store; when absent, the
 * provider status is recorded as "no_admin_key" and the source is skipped.
 *
 * Admin providers are sourced by the credential store from `src/auth/store.ts`
 * (Phase 3 module). The store contract is described in local://contracts.md;
 * if Phase 3 has not landed yet, this module will fail to type-check on
 * that import — every other call here is self-consistent.
 */
import type { Database } from "bun:sqlite";
import type { Config } from "../config/types.ts";
import { byId, type SourceKind } from "../registry.ts";
import { ingestOmp } from "./omp.ts";
import { ingestClaudeCode } from "./claudeCode.ts";
import { ingestAdminOpenai } from "./adminOpenai.ts";
import { ingestAdminAnthropic } from "./adminAnthropic.ts";
import { setProviderStatus, ensureProvider } from "../db/providers.ts";
import { load } from "../auth/store.ts";

export interface SyncSourceOutcome {
  source: string;
  inserted: number;
}

async function runOne(
  db: Database,
  dataDir: string,
  kind: SourceKind,
  full: boolean,
): Promise<{ inserted: number; status: string }> {
  switch (kind) {
    case "LogOmp":
      return ingestOmp(db, full);
    case "LogClaudeCode":
      return ingestClaudeCode(db, full);
    case "AdminOpenAI": {
      const creds = load(dataDir, "openai-api");
      const apiKey = creds.find((c) => c.type === "api_key")?.key;
      if (!apiKey) {
        ensureProvider(db, "openai-api", "OpenAI (admin)", "AdminOpenAI");
        setProviderStatus(db, "openai-api", "no_admin_key");
        return { inserted: 0, status: "no_admin_key" };
      }
      return ingestAdminOpenai(db, apiKey);
    }
    case "AdminAnthropic": {
      const creds = load(dataDir, "anthropic-api");
      const apiKey = creds.find((c) => c.type === "api_key")?.key;
      if (!apiKey) {
        ensureProvider(db, "anthropic-api", "Anthropic (admin)", "AdminAnthropic");
        setProviderStatus(db, "anthropic-api", "no_admin_key");
        return { inserted: 0, status: "no_admin_key" };
      }
      return ingestAdminAnthropic(db, apiKey);
    }
  }
}

/**
 * Run every enabled provider's ingestion source. Returns per-provider
 * inserted counts in the order they ran. omp-log providers (id != "omp")
 * are skipped — they are filtered views into already-ingested data.
 */
export async function runSync(
  db: Database,
  cfg: Config,
  dataDir: string,
  full: boolean,
): Promise<SyncSourceOutcome[]> {
  const out: SyncSourceOutcome[] = [];
  let ompDone = false;
  let ccDone = false;
  for (const prov of cfg.providers) {
    if (!prov.enabled) continue;
    const def = byId(prov.id);
    if (!def) {
      setProviderStatus(db, prov.id, "unknown");
      continue;
    }
    let shouldRun = true;
    if (def.sourceKind === "LogOmp") {
      // Only the raw "omp" entry (omp_provider === null) triggers the scan.
      if (def.ompProvider !== null || ompDone) shouldRun = false;
      else ompDone = true;
    } else if (def.sourceKind === "LogClaudeCode") {
      if (ccDone) shouldRun = false;
      else ccDone = true;
    }
    if (!shouldRun) continue;
    try {
      const r = await runOne(db, dataDir, def.sourceKind, full);
      out.push({ source: prov.id, inserted: r.inserted });
      if (r.status) setProviderStatus(db, prov.id, r.status);
    } catch (e) {
      const msg = `error: ${(e as Error).message}`;
      setProviderStatus(db, prov.id, msg);
      out.push({ source: prov.id, inserted: 0 });
    }
  }
  return out;
}