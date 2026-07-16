#!/usr/bin/env bun
import { parseArgs } from "node:util";

type Handler = (argv: string[]) => Promise<void>;

// Dynamic import cannot be static here: the subcommand is runtime-selected from
// argv, and lazy loading lets a plain CLI call run without initializing the
// ink/React TUI runtime (and lets each subcommand load independently).
const COMMANDS: Record<string, () => Promise<{ run: Handler }>> = {
  report: () => import("./cli/report.ts"),
  sync: () => import("./cli/sync.ts"),
  login: () => import("./cli/login.ts"),
  accounts: () => import("./cli/accounts.ts"),
  window: () => import("./cli/window.ts"),
  limit: () => import("./cli/limit.ts"),
  alerts: () => import("./cli/alerts.ts"),
  usage: () => import("./cli/usage.ts"),
  graph: () => import("./cli/graph.ts"),
};

const USAGE = `atop — Agent Token Observer & Monitor

Usage: atop [command] [options]

Commands:
  (none)      Launch the live TUI dashboard
  report      Print today's spend + per-provider window status
  sync        Run ingestion now (--full re-reads from byte 0)
  usage       Fetch live provider usage/quota
  graph       Plot hourly token-usage rate (--span, --provider)
  login       Authenticate a provider (OAuth or API key)
  accounts    List or remove stored accounts
  window      Set the active usage window for a provider
  limit       Set token or cost limits for a provider
  alerts      Configure or test threshold alerts
`;

async function main(): Promise<void> {
  const { positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: false,
  });

  const cmd = positionals[0];

  if (cmd === undefined) {
    const { run } = await import("./tui/run.ts");
    await run();
    return;
  }

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(USAGE);
    return;
  }

  const loader = COMMANDS[cmd];
  if (!loader) {
    process.stderr.write(`atop: unknown command '${cmd}'\n\n${USAGE}`);
    process.exit(1);
  }

  const mod = await loader();
  await mod.run(process.argv.slice(3));
}

main().catch((err) => {
  process.stderr.write(`atop: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
