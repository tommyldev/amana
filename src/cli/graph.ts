import { parseArgs } from "node:util";
import type { Database } from "bun:sqlite";
import { cliContext } from "./context.ts";
import { runSync } from "../ingest/sync.ts";
import { hourlyByProvider, windowSeries } from "../db/series.ts";
import { windowUsage } from "../db/usage.ts";
import { sourcesFor } from "../report/snapshot.ts";
import { byId } from "../registry.ts";
import { renderHourlyGraph } from "../report/graph.ts";
import { fmtTokens } from "../report/format.ts";

const HOUR_MS = 3_600_000;

export interface ProviderSeries {
  buckets: number[];
  total: number;
  cost: number;
}

/**
 * Hourly token buckets + total/cost for ONE provider, scoped by its log
 * source(s) and omp `provider` filter — exactly like the TUI drill-in. This is
 * what makes `--provider omp`/`claude-code` (aggregate source ids, never a raw
 * event `provider` value) resolve real data instead of an empty chart.
 */
export function providerSeries(
  db: Database,
  id: string,
  startMs: number,
  endMs: number,
  span: number,
): ProviderSeries {
  const sources = sourcesFor(id);
  const ompProvider = byId(id)?.ompProvider ?? undefined;
  const buckets = windowSeries(db, startMs, endMs, sources, ompProvider, span);
  const agg = windowUsage(db, startMs, endMs, sources, ompProvider);
  return { buckets, total: agg.total, cost: agg.cost };
}

/**
 * `amana graph [--span 24] [--provider <id>] [--full]` — sync, then print a
 * text bar chart of the token-usage rate (tokens per hour) over the last
 * `span` hours, plus a per-provider breakdown.
 */
export async function run(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      span: { type: "string" },
      provider: { type: "string" },
      full: { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  });

  const span = Math.min(Math.max(Math.trunc(Number(values.span ?? 24)) || 24, 1), 168);
  const { db, cfg, dataDir } = cliContext();
  await runSync(db, cfg, dataDir, values.full === true);

  const startMs = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - (span - 1) * HOUR_MS;
  const endMs = startMs + span * HOUR_MS;

  if (values.provider !== undefined) {
    const s = providerSeries(db, values.provider, startMs, endMs, span);
    process.stdout.write(
      `token usage/hour · last ${span}h · ${values.provider} · ${fmtTokens(s.total)} tok · $${s.cost.toFixed(2)}\n`,
    );
    process.stdout.write(renderHourlyGraph(s.buckets, startMs) + "\n");
    return;
  }

  const series = hourlyByProvider(db, startMs, HOUR_MS, span);
  const total = new Array<number>(span).fill(0);
  for (const p of series) {
    for (let i = 0; i < span; i++) total[i]! += p.buckets[i] ?? 0;
  }
  const totalTokens = total.reduce((a, b) => a + b, 0);
  const estCost = series.reduce((a, p) => a + p.estCost, 0);

  process.stdout.write(
    `token usage/hour · last ${span}h · ${fmtTokens(totalTokens)} tok · $${estCost.toFixed(2)}\n`,
  );
  process.stdout.write(renderHourlyGraph(total, startMs) + "\n");

  if (series.length > 0) {
    process.stdout.write("\nby provider:\n");
    for (const p of series) {
      if (p.totalTokens === 0) continue;
      const share = totalTokens > 0 ? Math.round((p.totalTokens / totalTokens) * 100) : 0;
      process.stdout.write(
        `  ${p.provider.padEnd(22)} ${fmtTokens(p.totalTokens).padStart(8)} tok  $${p.estCost.toFixed(2).padStart(7)}  ${String(share).padStart(3)}%\n`,
      );
    }
  }
}
