/**
 * Ollama usage fetcher. Ollama does not expose a quota endpoint, so we emit
 * an empty report with an explanatory note — same shape as the Rust fetcher.
 */
import type { Database } from "bun:sqlite";
import type { UsageReport } from "../types.ts";
import type { Credential } from "../../auth/types.ts";
import type { UsageFetcher } from "../fetcher.ts";

export const ollamaFetcher: UsageFetcher = {
  provider: "ollama",
  async fetch(cred: Credential, _db: Database): Promise<UsageReport | null> {
    return {
      provider: "ollama",
      account: cred.type === "api_key" ? (cred.account ?? "api key") : (cred.email ?? cred.account_id ?? "account"),
      fetchedAt: Date.now(),
      limits: [],
      notes: ["Ollama does not expose a standalone quota usage API; per-response token usage is reported during requests."],
    };
  },
};