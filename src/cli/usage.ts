/**
 * `amana usage` — fetch live provider usage/quota using Agent Mana's stored
 * credentials and print a compact text report (or `--json` for machine
 * output). Port of `cli/usage_cmd.rs`.
 */
import { parseArgs } from "node:util";
import { cliContext } from "./context.ts";
import { allProviders } from "../auth/store.ts";
import { fetchAll } from "../usage/orchestrator.ts";
import type { UsageLimit, UsageReport } from "../usage/types.ts";
import { unitShort } from "../usage/types.ts";
import { formatUsageBreakdown } from "../report/usageBreakdown.ts";

export async function run(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean" },
      provider: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });

  const { db, dataDir } = cliContext();
  const providers = values.provider !== undefined ? [values.provider] : allProviders(dataDir);
  if (providers.length === 0) {
    throw new Error("no providers have stored credentials; run `amana login <provider>` first");
  }

  const result = await fetchAll(db, dataDir, { provider: values.provider });

  if (result.errors.length > 0) {
    process.stderr.write(`Agent Mana: ${result.errors.length} fetch error(s):\n`);
    for (const e of result.errors) {
      process.stderr.write(`  - ${e.provider} (${e.account}): ${e.message}\n`);
    }
  }

  if (result.reports.length === 0) {
    console.log("Agent Mana: no usage reports returned (login first or check network)");
    return;
  }

  if (values.json) {
    const out = result.reports.map(toJsonReport);
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(formatUsageBreakdown(result.reports, Date.now()));
  }
}

interface JsonLimit {
  id: string;
  label: string;
  tier?: string;
  status: string;
  used?: number;
  limit?: number;
  used_fraction?: number;
  unit: string;
  window_label?: string;
  window_resets_at?: number;
}

interface JsonReport {
  provider: string;
  account: string;
  fetched_at: number;
  limits: JsonLimit[];
}

function toJsonReport(r: UsageReport): JsonReport {
  return {
    provider: r.provider,
    account: r.account,
    fetched_at: r.fetchedAt,
    limits: r.limits.map(toJsonLimit),
  };
}

function toJsonLimit(l: UsageLimit): JsonLimit {
  return {
    id: l.id,
    label: l.label,
    tier: l.tier,
    status: l.status,
    used: l.amount.used,
    limit: l.amount.limit,
    used_fraction: l.amount.usedFraction,
    unit: unitShort(l.amount.unit),
    window_label: l.window?.label,
    window_resets_at: l.window?.resetsAt,
  };
}
