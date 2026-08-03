/**
 * Shared provider-login flows, reused by the `amana login` CLI and the TUI's
 * in-app provider manager. Each flow health-checks BEFORE persisting (a bad
 * credential never gets stored) and, on success, enables the provider in
 * config so it is tracked immediately. These flows are interactive (browser
 * OAuth, terminal prompts) and MUST run while the process owns the normal
 * terminal — the TUI suspends its alternate screen before calling them.
 */
import type { Database } from "bun:sqlite";
import type { Credential } from "./types.ts";
import type { AuthMethod, Config } from "../config/types.ts";
import * as anthropicOauth from "./oauth/anthropic.ts";
import * as googleOauth from "./oauth/google.ts";
import * as openaiCodexOauth from "./oauth/openaiCodex.ts";
import * as minimaxOauth from "./oauth/minimax.ts";
import * as kimiOauth from "./oauth/kimi.ts";
import * as xaiOauth from "./oauth/xai.ts";
import * as opencodeOauth from "./oauth/opencode.ts";
import { cliUi, type LoginUi } from "./oauth/ui.ts";
import { byId } from "../registry.ts";
import * as credStore from "./store.ts";
import { validateAdminKey } from "./adminValidate.ts";
import { saveConfig } from "../config/config.ts";
import { promptText } from "../cli/prompt.ts";
import { fetcherFor, supported as supportedProviders } from "../usage/fetcher.ts";

export type LoginKind = "ApiKey" | "OAuth" | "AdminKey";

/** Everything a login flow needs to persist a credential and enable tracking. */
export interface LoginCtx {
  db: Database;
  dataDir: string;
  cfg: Config;
  configFile: string;
}

const API_KEY_ONLY: Record<string, true> = {
  zai: true,
  "github-copilot": true,
  deepseek: true,
};
const PURE_OAUTH: Record<string, true> = {
  anthropic: true,
  "google-antigravity": true,
  "google-gemini-cli": true,
};
const MIXED_APIKEY_OAUTH: Record<string, true> = {
  "openai-codex": true,
  "minimax-code": true,
  "minimax-code-cn": true,
  "opencode-go": true,
};
const OAUTH_ONLY: Record<string, true> = { "kimi-code": true, "xai-oauth": true };
const ADMIN_KEY: Record<string, true> = { "openai-api": true, "anthropic-api": true };

/** True when the provider accepts an api-key credential in addition to OAuth. */
export function isMixed(id: string): boolean {
  return MIXED_APIKEY_OAUTH[id] === true;
}

/** True when the provider is OAuth-only (no api-key path). */
export function isPureOauth(id: string): boolean {
  return PURE_OAUTH[id] === true || OAUTH_ONLY[id] === true;
}

/** The default/primary login kind for a provider, or undefined when unsupported. */
export function loginKindFor(id: string): LoginKind | undefined {
  if (API_KEY_ONLY[id]) return "ApiKey";
  if (ADMIN_KEY[id]) return "AdminKey";
  if (PURE_OAUTH[id] || MIXED_APIKEY_OAUTH[id] || OAUTH_ONLY[id]) return "OAuth";
  return undefined;
}

/** Provider ids Agent Mana has a login flow for (fetchers + admin-API providers). */
export function loginableIds(): string[] {
  const v = supportedProviders().slice();
  for (const id of Object.keys(ADMIN_KEY)) if (!v.includes(id)) v.push(id);
  return v.filter((id) => loginKindFor(id) !== undefined);
}

/** Enable + tag a provider in config so the overview tracks it after login. */
function enableProvider(cfg: Config, id: string, method: AuthMethod): void {
  const existing = cfg.providers.find((p) => p.id === id);
  if (existing) {
    existing.enabled = true;
    existing.auth_method = method;
    return;
  }
  cfg.providers.push({
    id,
    enabled: true,
    auth_method: method,
    usage_window: { type: "rolling", duration: "5h" },
    extra_windows: [],
    limits: {},
  });
}

/** Health-check a credential via the provider's fetcher; throws on failure. */
export async function healthCheck(db: Database, id: string, cred: Credential): Promise<void> {
  const fetcher = fetcherFor(id);
  if (!fetcher) throw new Error(`Agent Mana has no fetcher for '${id}'`);
  try {
    if (fetcher.validate) {
      await fetcher.validate(cred, db);
      return;
    }
    const report = await fetcher.fetch(cred, db);
    // A null report for an OAuth credential is not a failure: the token exchange
    // itself proved the credential, and a fresh account may have no usage yet.
    // For api_key credentials, null more likely indicates a bad/unrecognized key.
    if (!report && cred.type !== "oauth") throw new Error("no usage data returned");
  } catch (e) {
    throw new Error(`${id} health-check failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Prompt for an api key (+ optional account/enterprise url), verify, store, enable. */
export async function apiKeyLogin(ctx: LoginCtx, id: string): Promise<void> {
  const key = await promptText(`${id} API key`);
  const accountRaw = await promptText("Account label (optional)", true);
  const account = accountRaw.length > 0 ? accountRaw : undefined;
  let enterprise_url: string | undefined;
  if (id === "github-copilot") {
    const urlRaw = await promptText("GitHub Enterprise API base URL (optional)", true);
    enterprise_url = urlRaw.length > 0 ? urlRaw : undefined;
  }
  await storeApiKey(ctx, id, { key, account, enterprise_url });
  console.log(`${id}: stored api key (health-check ok)`);
}

/** Non-interactive core: validate + persist an api key, enable the provider.
 *  Shared by the CLI prompt flow and the in-TUI provider manager. */
export async function storeApiKey(
  ctx: LoginCtx,
  id: string,
  input: { key: string; account?: string; enterprise_url?: string },
): Promise<void> {
  const cred: Credential = {
    type: "api_key",
    key: input.key,
    ...(input.account ? { account: input.account } : {}),
    ...(input.enterprise_url ? { enterprise_url: input.enterprise_url } : {}),
  };
  await healthCheck(ctx.db, id, cred);
  credStore.upsert(ctx.dataDir, id, cred);
  enableProvider(ctx.cfg, id, "api_key");
  saveConfig(ctx.configFile, ctx.cfg);
}

/** Run the provider's browser OAuth flow, verify, store, enable. `apiKeyFlag`
 *  routes a mixed provider to its api-key path instead. */
export async function oauthLogin(ctx: LoginCtx, id: string, apiKeyFlag: boolean, ui: LoginUi = cliUi()): Promise<void> {
  if (apiKeyFlag) {
    if (!isMixed(id)) throw new Error(`${id} does not support api-key login`);
    await apiKeyLogin(ctx, id);
    return;
  }
  let cred: Credential;
  switch (id) {
    case "anthropic": cred = await anthropicOauth.login(undefined, ui); break;
    case "google-antigravity":
    case "google-gemini-cli": cred = await googleOauth.login(id, ui); break;
    case "openai-codex": cred = await openaiCodexOauth.login(id, ui); break;
    case "minimax-code":
    case "minimax-code-cn": cred = await minimaxOauth.login(id, ui); break;
    case "kimi-code": cred = await kimiOauth.login(id, ui); break;
    case "xai-oauth": cred = await xaiOauth.login(id, ui); break;
    case "opencode-go": cred = await opencodeOauth.login(id, ui); break;
    default: throw new Error(`Agent Mana has no OAuth flow for '${id}' yet`);
  }
  await healthCheck(ctx.db, id, cred);
  credStore.upsert(ctx.dataDir, id, cred);
  enableProvider(ctx.cfg, id, "oauth");
  saveConfig(ctx.configFile, ctx.cfg);
  console.log(`${id}: health-check ok`);
}

/** Prompt for an admin API key, validate against the admin endpoint, store, enable. */
export async function adminKeyLogin(ctx: LoginCtx, id: string): Promise<void> {
  const key = await promptText(`Admin key for ${id}`);
  await storeAdminKey(ctx, id, key);
  console.log(`${id}: enabled`);
}

/** Non-interactive core: validate + persist an admin key, enable the provider. */
export async function storeAdminKey(ctx: LoginCtx, id: string, key: string): Promise<void> {
  const def = byId(id);
  if (!def) throw new Error(`unknown provider: ${id}`);
  await validateAdminKey(def.sourceKind, key);
  credStore.upsert(ctx.dataDir, id, { type: "api_key", key });
  enableProvider(ctx.cfg, id, "api_key");
  saveConfig(ctx.configFile, ctx.cfg);
}
