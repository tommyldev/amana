import React from "react";
import { Box, Text } from "ink";
import type { Database } from "bun:sqlite";
import type { TuiState } from "../state.ts";
import { UsageChart } from "../widgets/UsageChart.tsx";
import { LineGauge } from "../widgets/LineGauge.tsx";
import { Table } from "../widgets/Table.tsx";
import { limitPct } from "./derive.ts";
import { breakdownByModel } from "../../db/breakdown.ts";
import { windowSeries } from "../../db/series.ts";
import { sourcesFor } from "../../report/snapshot.ts";
import { byId } from "../../registry.ts";
import { colorFor } from "../theme.ts";
import { fmtDuration, fmtTokens } from "../../report/format.ts";
import { snapshotDeltaSeries, snapshotLevelSeries, type SnapshotLevel } from "../../db/snapshots.ts";
import { useTerminalSize } from "../useTerminalSize.ts";

const HOUR_MS = 3_600_000;

function resetsIn(resetsAt: number | undefined): string {
	if (resetsAt === undefined) return "";
	const secs = Math.floor((resetsAt - Date.now()) / 1000);
	return secs > 0 ? ` · resets in ${fmtDuration(secs)}` : "";
}
/** Header stat: quota level when charting the fill ramp, else span totals. */
function headerStat(unit: string, chartTotal: number, level: SnapshotLevel | null): string {
  if (level) {
    if (level.unit === "percent") return `${level.latestUsed.toFixed(0)}% of quota`;
    const cap = level.latestLimit !== null ? ` / ${fmtTokens(level.latestLimit)}` : "";
    return `${fmtTokens(level.latestUsed)}${cap} tok · quota level`;
  }
  return unit === "percent" ? `${chartTotal.toFixed(0)}% used` : `${fmtTokens(chartTotal)} tok`;
}


export function ProviderView({ state, db }: { state: TuiState; db: Database }): React.JSX.Element {
  const id = state.drillProvider ?? "";
  const reports = state.reports.filter((r) => r.provider === id);
  const errors = state.errors.filter((e) => e.provider === id);
  const startMs = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - (state.span - 1) * HOUR_MS;
  const endMs = startMs + state.span * HOUR_MS;
  const { rows } = useTerminalSize();
  const chartH = Math.max(8, Math.min(Math.floor(rows / 2), 14));
  // Scope the chart + model table to this provider's log sources (and omp
  // `provider` filter). tokenSeries is keyed by the raw event `provider`
  // field, which doesn't match aggregate ids like "omp"/"claude-code" — so
  // query the source-scoped series directly, exactly like breakdownByModel.
  const sources = sourcesFor(id);
  const ompProvider = byId(id)?.ompProvider ?? undefined;
  const buckets = windowSeries(db, startMs, endMs, sources, ompProvider, state.span);
  const totalTokens = buckets.reduce((a, b) => a + b, 0);
  let chartData = buckets;
  let chartTotal = totalTokens;
  let unit = "tok";
  let level: SnapshotLevel | null = null;
  if (totalTokens === 0) {
    // No log events for this provider: fall back to the polled snapshot
    // series — consumption rate first, quota-fill level while deltas are
    // still accumulating (rate needs 2+ polls inside the span).
    chartData = snapshotDeltaSeries(db, startMs, endMs, { provider: id, buckets: state.span });
    chartTotal = chartData.reduce((a, b) => a + b, 0);
    const row = db.query("SELECT unit FROM usage_snapshots WHERE provider = ? ORDER BY fetched_at_ms DESC LIMIT 1").get(id) as { unit?: string } | undefined;
    unit = row?.unit ?? "tok";
    if (chartTotal === 0) {
      level = snapshotLevelSeries(db, startMs, endMs, id, state.span);
      if (level) chartData = level.series;
    }
  }
  const models = breakdownByModel(db, startMs, endMs, sources, ompProvider);
  // Local providers have no live `reports`; surface their configured window
  // usage from the shared limitRows (per-window since the multi-window cycle).
  const localRows = state.limitRows.filter((r) => r.provider === id && !r.error);

  return (
    <Box flexDirection="column">
      <Text bold color={colorFor(id)}>
        {byId(id)?.label ?? id} · last {state.span}h · {headerStat(unit, chartTotal, level)}
      </Text>

      {reports.map((r) => (
        <Box key={r.account} flexDirection="column" marginTop={1}>
          <Text bold>{r.account}</Text>
          {r.limits.map((l) => (
            <Box key={l.id}>
              <Text>{`  ${l.label.padEnd(18)}`}</Text>
              <LineGauge value={limitPct(l)} dot />
              <Text dimColor>{resetsIn(l.window?.resetsAt)}</Text>
            </Box>
          ))}
        </Box>
      ))}
      {errors.map((e, i) => (
        <Text key={`err-${i}`} color="red">
          {e.account}: {e.message}
        </Text>
      ))}

      {reports.length === 0 && localRows.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {localRows.map((row, i) => (
            <Box key={`${row.limitLabel}-${i}`}>
              <Text>{`  ${row.limitLabel.padEnd(23)} `}</Text>
              {row.gauge ? <LineGauge value={row.pct} dot /> : null}
              <Text dimColor>{`  ${row.detail}${resetsIn(row.resetsAt)}`}</Text>
            </Box>
          ))}
        </Box>
      ) : null}

      <Box marginY={1} flexDirection="column">
        <UsageChart data={chartData} startMs={startMs} height={chartH} />
        {level ? <Text dimColor>quota fill level · polled every refresh; rate chart appears after a few polls</Text> : null}
      </Box>

      {models.length > 0 ? (
        <Table
          columns={[
            { header: "model", width: 30 },
            { header: "reqs", width: 6, align: "right" },
            { header: "tokens", width: 9, align: "right" },
            { header: "est $", width: 9, align: "right" },
          ]}
          rows={models.map((m) => [m.model, String(m.requests), fmtTokens(m.total_tokens), `$${m.cost.toFixed(2)}`])}
        />
      ) : (
        <Text dimColor>no model activity for {id} in the last {state.span}h</Text>
      )}
    </Box>
  );
}
