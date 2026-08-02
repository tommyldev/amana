/**
 * Provider-agnostic `UsageFetcher` contract + dispatch. Port of
 * `legacy-rust/src/usage/mod.rs::UsageFetcher` / `fetcher_for` / `supported`.
 *
 * Implementations live in `./providers/<name>.ts` and are wired by id.
 */
import type { Database } from "bun:sqlite";
import type { Credential } from "../auth/types.ts";
import type { UsageReport } from "./types.ts";
import { SUPPORTED_PROVIDERS } from "./types.ts";

export interface UsageFetcher {
  /** The provider id this fetcher is registered under. */
  provider: string;
  /** Resolve live usage for `cred`. Returns `null` when the provider reports
   *  nothing for this credential (e.g. unknown credential type). */
  fetch(cred: Credential, db: Database): Promise<UsageReport | null>;
  /** Optional lightweight health check used by `atop login`. Default calls
   *  `fetch` and treats an empty report as failure. */
  validate?(cred: Credential, db: Database): Promise<void>;
}

import { zaiFetcher } from "./providers/zai.ts";
import { anthropicFetcher } from "./providers/anthropic.ts";
import { githubCopilotFetcher } from "./providers/githubCopilot.ts";
import { googleAntigravityFetcher } from "./providers/googleAntigravity.ts";
import { googleGeminiCliFetcher } from "./providers/googleGeminiCli.ts";
import { openaiCodexFetcher } from "./providers/openaiCodex.ts";
import { kimiCodeFetcher } from "./providers/kimiCode.ts";
import { minimaxFetcher, minimaxCnFetcher } from "./providers/minimax.ts";
import { deepseekFetcher } from "./providers/deepseek.ts";
import { opencodeGoFetcher } from "./providers/opencodeGo.ts";
import { ollamaFetcher } from "./providers/ollama.ts";
import { xaiOauthFetcher } from "./providers/xaiOauth.ts";

const REGISTRY: Record<string, UsageFetcher> = {
  "zai": zaiFetcher,
  "anthropic": anthropicFetcher,
  "github-copilot": githubCopilotFetcher,
  "google-antigravity": googleAntigravityFetcher,
  "google-gemini-cli": googleGeminiCliFetcher,
  "openai-codex": openaiCodexFetcher,
  "kimi-code": kimiCodeFetcher,
  "minimax-code": minimaxFetcher,
  "minimax-code-cn": minimaxCnFetcher,
  "opencode-go": opencodeGoFetcher,
  "deepseek": deepseekFetcher,
  "ollama": ollamaFetcher,
  "xai-oauth": xaiOauthFetcher,
};

/** Return the fetcher for `id`, or `undefined` when no fetcher is registered. */
export function fetcherFor(id: string): UsageFetcher | undefined {
  return REGISTRY[id];
}

/** Providers atop can fetch live usage for. Mirrors `SUPPORTED_PROVIDERS`. */
export function supported(): string[] {
  return SUPPORTED_PROVIDERS;
}