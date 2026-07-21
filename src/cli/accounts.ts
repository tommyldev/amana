/**
 * `amana accounts list` / `amana accounts remove <provider> [--account <label>]`
 * — inspect and prune stored provider credentials.
 *
 * Port of `legacy-rust/src/cli/accounts_cmd.rs`. Removal matches on either
 * `accountLabel(cred)` or `identity(cred)` (the same label an OAuth refresh
 * would use to dedupe).
 */
import { parseArgs } from "node:util";
import * as credStore from "../auth/store.ts";
import type { Credential } from "../auth/types.ts";
import { accountLabel, identity } from "../auth/types.ts";
import { cliContext } from "./context.ts";
import { promptSelect } from "./prompt.ts";

export async function run(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { account: { type: "string" } },
    allowPositionals: true,
    strict: false,
  });
  const sub = positionals[0];
  const { dataDir } = cliContext();

  switch (sub) {
    case "list":
      listAccounts(dataDir);
      return;
    case "remove": {
      const provider = positionals[1];
      if (!provider) throw new Error("accounts remove: provider is required");
      const labelFlag = typeof values.account === "string" ? values.account : undefined;
      removeAccount(dataDir, provider, labelFlag);
      return;
    }
    default:
      throw new Error(`accounts: unknown subcommand '${sub ?? ""}' (expected 'list' or 'remove')`);
  }
}

function listAccounts(dataDir: string): void {
  const providers = credStore.allProviders(dataDir);
  if (providers.length === 0) {
    console.log("no accounts stored");
    return;
  }
  const rows: Row[] = [];
  for (const provider of providers) {
    for (const cred of credStore.load(dataDir, provider)) {
      rows.push({
        provider,
        account: accountLabel(cred),
        kind: cred.type,
        expiry: formatExpiry(cred),
      });
    }
  }
  const widths = {
    provider: Math.max("PROVIDER".length, ...rows.map((r) => r.provider.length)),
    account: Math.max("ACCOUNT".length, ...rows.map((r) => r.account.length)),
    kind: Math.max("KIND".length, ...rows.map((r) => r.kind.length)),
    expiry: Math.max("EXPIRY".length, ...rows.map((r) => r.expiry.length)),
  };
  const fmt = (s: string, n: number): string => s + " ".repeat(Math.max(0, n - s.length));
  console.log(
    `${fmt("PROVIDER", widths.provider)}  ${fmt("ACCOUNT", widths.account)}  ${fmt("KIND", widths.kind)}  ${fmt("EXPIRY", widths.expiry)}`,
  );
  for (const r of rows) {
    console.log(
      `${fmt(r.provider, widths.provider)}  ${fmt(r.account, widths.account)}  ${fmt(r.kind, widths.kind)}  ${r.expiry}`,
    );
  }
}

interface Row {
  provider: string;
  account: string;
  kind: string;
  expiry: string;
}

function formatExpiry(cred: Credential): string {
  if (cred.type !== "oauth") return "-";
  if (cred.expires === undefined) return "no expiry";
  const diffMs = cred.expires - Date.now();
  if (diffMs <= 0) return "expired";
  return `in ${humanDuration(diffMs)}`;
}

function humanDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  return `${d}d`;
}

async function removeAccount(dataDir: string, provider: string, accountFlag: string | undefined): Promise<void> {
  const creds = credStore.load(dataDir, provider);
  if (creds.length === 0) {
    throw new Error(`no stored credentials for '${provider}'`);
  }

  if (accountFlag !== undefined) {
    const idx = creds.findIndex((c) => accountLabel(c) === accountFlag || identity(c) === accountFlag);
    if (idx < 0) {
      const labels = creds.map(accountLabel).join(", ");
      throw new Error(`no account matching '${accountFlag}' for '${provider}' (have: ${labels})`);
    }
    const target = creds[idx]!;
    creds.splice(idx, 1);
    credStore.save(dataDir, provider, creds);
    console.log(`removed ${provider} · ${accountLabel(target)}`);
    return;
  }

  if (creds.length === 1) {
    const only = creds[0]!;
    credStore.save(dataDir, provider, []);
    console.log(`removed ${provider} · ${accountLabel(only)}`);
    return;
  }

  const idx = await promptSelect(
    `Multiple accounts for '${provider}' — pick one to remove:`,
    creds.map(accountLabel),
  );
  const target = creds[idx]!;
  const rebuilt = creds.filter((_, i) => i !== idx);
  credStore.save(dataDir, provider, rebuilt);
  console.log(`removed ${provider} · ${accountLabel(target)}`);
}
