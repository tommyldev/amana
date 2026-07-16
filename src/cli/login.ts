/**
 * `atop login [provider]` — authenticate a provider. Health-checks run
 * BEFORE `upsert` so a bad credential never gets persisted. Port of
 * `legacy-rust/src/cli/login_cmd.rs::run`.
 */
import { parseArgs } from "node:util";
import type { Database } from "bun:sqlite";
import type { Credential } from "../auth/types.ts";
import * as anthropicOauth from "../auth/oauth/anthropic.ts";
import * as googleOauth from "../auth/oauth/google.ts";
import * as openaiCodexOauth from "../auth/oauth/openaiCodex.ts";
import * as minimaxOauth from "../auth/oauth/minimax.ts";
import { byId } from "../registry.ts";
import * as credStore from "../auth/store.ts";
import { validateAdminKey } from "../auth/adminValidate.ts";
import type { Config } from "../config/types.ts";
import { saveConfig } from "../config/config.ts";
import { cliContext } from "./context.ts";
import { promptPassword, promptSelect, promptText } from "./prompt.ts";
import { fetcherFor, supported as supportedProviders } from "../usage/fetcher.ts";

type LoginKind = "ApiKey" | "OAuth" | "AdminKey";

function kindFor(id: string): LoginKind | undefined {
  switch (id) {
    case "zai":
    case "github-copilot":
      return "ApiKey";
    case "anthropic":
    case "google-antigravity":
    case "google-gemini-cli":
    case "openai-codex":
    case "minimax-code":
    case "minimax-code-cn":
    case "kimi-code":
    case "xai-oauth":
      return "OAuth";
    case "openai-api":
    case "anthropic-api":
      return "AdminKey";
    default:
      return undefined;
  }
}

const PURE_OAUTH: Record<string, true> = {
  anthropic: true,
  "google-antigravity": true,
  "google-gemini-cli": true,
};

const MIXED_APIKEY_OAUTH: Record<string, true> = {
  "openai-codex": true,
  "minimax-code": true,
  "minimax-code-cn": true,
};

function loginable(): string[] {
  const v = supportedProviders().slice();
  if (!v.includes("openai-api")) v.push("openai-api");
  if (!v.includes("anthropic-api")) v.push("anthropic-api");
  return v;
}

export async function run(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { "api-key": { type: "boolean" } },
    allowPositionals: true,
    strict: false,
  });

  const id = positionals[0] ?? (await pickProvider());
  const apiKeyFlag = values["api-key"] === true;

  if (apiKeyFlag && PURE_OAUTH[id] === true) {
    throw new Error(`${id} does not support api-key login`);
  }

  const kind = kindFor(id);
  if (kind === undefined) {
    throw new Error(
      `atop has no login flow for '${id}' yet. supported: ${loginable().join(", ")}`,
    );
  }

  const ctx = cliContext();
  switch (kind) {
    case "ApiKey":
      await apiKeyFlow(ctx.db, ctx.dataDir, id);
      return;
    case "OAuth":
      await oauthFlow(ctx.db, ctx.dataDir, id, apiKeyFlag);
      return;
    case "AdminKey":
      await adminKeyFlow(ctx.paths.configFile, ctx.cfg, ctx.dataDir, id);
      return;
  }
}

async function pickProvider(): Promise<string> {
  const items = loginable().map((id) => {
    const label = byId(id)?.label;
    return label ? `${id} (${label})` : id;
  });
  const idx = await promptSelect("Choose a provider to log in:", items);
  return loginable()[idx]!;
}

async function apiKeyFlow(db: Database, dataDir: string, id: string): Promise<void> {
  const key = await promptPassword(`${id} API key`);
  const accountRaw = await promptText("Account label (optional)", true);
  const account = accountRaw.length > 0 ? accountRaw : undefined;
  let enterprise_url: string | undefined;
  if (id === "github-copilot") {
    const urlRaw = await promptText("GitHub Enterprise API base URL (optional)", true);
    enterprise_url = urlRaw.length > 0 ? urlRaw : undefined;
  }
  const cred: Credential = {
    type: "api_key",
    key,
    ...(account ? { account } : {}),
    ...(enterprise_url ? { enterprise_url } : {}),
  };
  await healthCheck(db, id, cred);
  credStore.upsert(dataDir, id, cred);
  console.log(`${id}: stored api key (health-check ok)`);
}

async function oauthFlow(db: Database, dataDir: string, id: string, apiKeyFlag: boolean): Promise<void> {
  if (apiKeyFlag) {
    if (MIXED_APIKEY_OAUTH[id] !== true) {
      throw new Error(`${id} does not support api-key login`);
    }
    await apiKeyFlow(db, dataDir, id);
    return;
  }
  if (PURE_OAUTH[id] !== true && MIXED_APIKEY_OAUTH[id] !== true) {
    throw new Error(`atop has no OAuth flow for '${id}' yet`);
  }
  let cred: Credential;
  switch (id) {
    case "anthropic": cred = await anthropicOauth.login(); break;
    case "google-antigravity":
    case "google-gemini-cli": cred = await googleOauth.login(id); break;
    case "openai-codex": cred = await openaiCodexOauth.login(id); break;
    case "minimax-code":
    case "minimax-code-cn": cred = await minimaxOauth.login(id); break;
    default: throw new Error(`atop has no OAuth flow for '${id}' yet`);
  }
  await healthCheck(db, id, cred);
  credStore.upsert(dataDir, id, cred);
  console.log(`${id}: health-check ok`);
}

async function adminKeyFlow(configFile: string, cfg: Config, dataDir: string, id: string): Promise<void> {
  const def = byId(id);
  if (!def) throw new Error(`unknown provider: ${id}`);
  const key = await promptPassword(`Admin key for ${id}`);
  await validateAdminKey(def.sourceKind, key);
  const cred: Credential = { type: "api_key", key };
  credStore.upsert(dataDir, id, cred);
  const existing = cfg.providers.find((p) => p.id === id);
  if (existing) {
    existing.enabled = true;
    existing.auth_method = "api_key";
  } else {
    cfg.providers.push({
      id,
      enabled: true,
      auth_method: "api_key",
      usage_window: { type: "rolling", duration: "5h" },
      extra_windows: [],
      limits: {},
    });
  }
  saveConfig(configFile, cfg);
  console.log(`${id}: enabled`);
}

async function healthCheck(db: Database, id: string, cred: Credential): Promise<void> {
  const fetcher = fetcherFor(id);
  if (!fetcher) throw new Error(`atop has no fetcher for '${id}'`);
  try {
    if (fetcher.validate) {
      await fetcher.validate(cred, db);
      return;
    }
    const report = await fetcher.fetch(cred, db);
    if (!report) throw new Error("no usage data returned");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`${id} health-check failed: ${msg}`);
  }
}
