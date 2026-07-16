import { parseArgs } from "node:util";
import { cliContext } from "./context.ts";
import { runSync } from "../ingest/sync.ts";
import { hourlyByProvider } from "../db/series.ts";
import { renderHourlyGraph } from "../report/graph.ts";
import { fmtTokens } from "../report/format.ts";

const HOUR_MS = 3_600_000;

/**
 * `atop graph [--span 24] [--provider <id>] [--full]` — sync, then print a
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
  const series = hourlyByProvider(db, startMs, HOUR_MS, span);
  const selected = values.provider !== undefined
    ? series.filter((p) => p.provider === values.provider)
    : series;

  const total = new Array<number>(span).fill(0);
  for (const p of selected) {
    for (let i = 0; i < span; i++) total[i]! += p.buckets[i] ?? 0;
  }
  const totalTokens = total.reduce((a, b) => a + b, 0);
  const estCost = selected.reduce((a, p) => a + p.estCost, 0);

  const scope = values.provider !== undefined ? ` · ${values.provider}` : "";
  process.stdout.write(
    `token usage/hour · last ${span}h${scope} · ${fmtTokens(totalTokens)} tok · $${estCost.toFixed(2)}\n`,
  );
  process.stdout.write(renderHourlyGraph(total, startMs) + "\n");

  if (values.provider === undefined && selected.length > 0) {
    process.stdout.write("\nby provider:\n");
    for (const p of selected) {
      if (p.totalTokens === 0) continue;
      const share = totalTokens > 0 ? Math.round((p.totalTokens / totalTokens) * 100) : 0;
      process.stdout.write(
        `  ${p.provider.padEnd(22)} ${fmtTokens(p.totalTokens).padStart(8)} tok  $${p.estCost.toFixed(2).padStart(7)}  ${String(share).padStart(3)}%\n`,
      );
    }
  }
}
