/**
 * `atop usage` — fetch live provider usage/quota using atop's stored
 * credentials and print a compact text report (or `--json` for machine
 * output). Port of `cli/usage_cmd.rs`.
 */
import { parseArgs } from "node:util";
import { cliContext } from "./context.ts";
import { allProviders } from "../auth/store.ts";
import { fetchAll } from "../usage/orchestrator.ts";
import type { UsageLimit, UsageReport } from "../usage/types.ts";
import { unitShort } from "../usage/types.ts";

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
    throw new Error("no providers have stored credentials; run `atop login <provider>` first");
  }

  const result = await fetchAll(db, dataDir, { provider: values.provider });

  if (result.errors.length > 0) {
    process.stderr.write(`atop: ${result.errors.length} fetch error(s):\n`);
    for (const e of result.errors) {
      process.stderr.write(`  - ${e.provider} (${e.account}): ${e.message}\n`);
    }
  }

  if (result.reports.length === 0) {
    console.log("atop: no usage reports returned (login first or check network)");
    return;
  }

  if (values.json) {
    const out = result.reports.map(toJsonReport);
    console.log(JSON.stringify(out, null, 2));
  } else {
    for (const r of result.reports) printText(r);
  }
}

function printText(r: UsageReport): void {
  console.log(`${r.provider} — ${r.account}`);
  for (const l of r.limits) printLimit(l);
  console.log();
}

function printLimit(l: UsageLimit): void {
  const pct = l.amount.usedFraction !== undefined
    ? `${Math.round(l.amount.usedFraction * 100)}%`
    : "?";
  const used = l.amount.used !== undefined ? `${Math.round(l.amount.used)}` : "?";
  const lim = l.amount.limit !== undefined ? `${Math.round(l.amount.limit)}` : "?";
  const unit = unitShort(l.amount.unit);
  const win = l.window ? `${l.window.label} (${l.window.id})` : "";
  const reset = l.window?.resetsAt !== undefined ? epochToIso(l.window.resetsAt) : "";
  const tier = l.tier !== undefined ? ` [${l.tier}]` : "";
  // Right-align the window field to width 10 to match the Rust format string.
  console.log(
    `  ${l.label}${tier}  ${win.padStart(10)}  ${used}/${lim} ${unit}  (${pct})  resets ${reset}`,
  );
}

/** Format epoch ms as `YYYY-MM-DD HH:MM UTC`. Matches `chrono` "%Y-%m-%d %H:%M UTC". */
function epochToIso(ms: number): string {
  if (!Number.isFinite(ms)) return "?";
  const iso = new Date(ms).toISOString();
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}):\d{2}\.\d{3}Z$/.exec(iso);
  if (!m) return "?";
  return `${m[1]} ${m[2]} UTC`;
}

interface JsonLimit {
  id: string;
  label: string;
  tier?: string;
  status: string;
  used?: number;
  limit?: number;
  usedFraction?: number;
  unit: string;
  windowLabel?: string;
  windowResetsAt?: number;
}

interface JsonReport {
  provider: string;
  account: string;
  fetchedAt: number;
  limits: JsonLimit[];
}

function toJsonReport(r: UsageReport): JsonReport {
  return {
    provider: r.provider,
    account: r.account,
    fetchedAt: r.fetchedAt,
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
    usedFraction: l.amount.usedFraction,
    unit: unitShort(l.amount.unit),
    windowLabel: l.window?.label,
    windowResetsAt: l.window?.resetsAt,
  };
}
