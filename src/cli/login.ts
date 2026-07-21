/**
 * `amana login [provider] [--api-key] [--key <value>] [--account <label>]
 * [--enterprise-url <url>]` — authenticate a provider. With `--key` the key is
 * stored non-interactively (no prompt / no pasting into any field); otherwise
 * the flow prompts. The actual flows (health-check-before-store, config enable)
 * live in `auth/loginFlows.ts` so the TUI's provider manager reuses them.
 */
import { parseArgs } from "node:util";
import { byId } from "../registry.ts";
import { cliContext } from "./context.ts";
import { promptSelect } from "./prompt.ts";
import {
  adminKeyLogin,
  apiKeyLogin,
  isMixed,
  isPureOauth,
  loginableIds,
  loginKindFor,
  oauthLogin,
  storeAdminKey,
  storeApiKey,
  type LoginCtx,
} from "../auth/loginFlows.ts";

type LoginKind = "ApiKey" | "OAuth" | "AdminKey";

/** A parsed option value as a non-empty string, or undefined. */
function str(v: string | boolean | undefined): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export async function run(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      "api-key": { type: "boolean" },
      key: { type: "string" },
      account: { type: "string" },
      "enterprise-url": { type: "string" },
    },
    allowPositionals: true,
    strict: false,
  });

  const id = positionals[0] ?? (await pickProvider());
  const apiKeyFlag = values["api-key"] === true;
  const key = str(values.key);

  if (apiKeyFlag && isPureOauth(id)) {
    throw new Error(`${id} does not support api-key login`);
  }

  const kind = loginKindFor(id);
  if (kind === undefined) {
    throw new Error(`Agent Mana has no login flow for '${id}' yet. supported: ${loginableIds().join(", ")}`);
  }

  const c = cliContext();
  const ctx: LoginCtx = { db: c.db, dataDir: c.dataDir, cfg: c.cfg, configFile: c.paths.configFile };

  if (key !== undefined) {
    return runWithKey(ctx, id, kind, key, str(values.account), str(values["enterprise-url"]));
  }

  switch (kind) {
    case "ApiKey":
      return apiKeyLogin(ctx, id);
    case "OAuth":
      return oauthLogin(ctx, id, apiKeyFlag);
    case "AdminKey":
      return adminKeyLogin(ctx, id);
  }
}

/** Store a key supplied on the command line — no interactive prompt/paste. */
async function runWithKey(
  ctx: LoginCtx,
  id: string,
  kind: LoginKind,
  key: string,
  account: string | undefined,
  enterprise_url: string | undefined,
): Promise<void> {
  if (kind === "AdminKey") {
    await storeAdminKey(ctx, id, key);
    console.log(`${id}: enabled`);
    return;
  }
  if (kind === "OAuth" && isPureOauth(id) && !isMixed(id)) {
    throw new Error(`${id} is OAuth-only; --key is not supported (run \`amana login ${id}\`)`);
  }
  await storeApiKey(ctx, id, { key, account, enterprise_url });
  console.log(`${id}: stored api key (health-check ok)`);
}

async function pickProvider(): Promise<string> {
  const ids = loginableIds();
  const items = ids.map((id) => {
    const label = byId(id)?.label;
    return label ? `${id} (${label})` : id;
  });
  const idx = await promptSelect("Choose a provider to log in:", items);
  return ids[idx]!;
}
