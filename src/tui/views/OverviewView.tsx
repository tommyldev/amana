import React from "react";
import { Box, Text } from "ink";
import type { TuiState } from "../state.ts";
import { UsageChart } from "../widgets/UsageChart.tsx";
import { LineGauge } from "../widgets/LineGauge.tsx";
import { fmtDuration, fmtTokens, truncate } from "../../report/format.ts";
import { useTerminalSize } from "../useTerminalSize.ts";
import { isAllTime, spanById } from "../spans.ts";

function resetsIn(resetsAt: number | undefined): string {
	if (resetsAt === undefined) return "";
	const secs = Math.floor((resetsAt - Date.now()) / 1000);
	return secs > 0 ? ` · resets in ${fmtDuration(secs)}` : "";
}

export function OverviewView({ state }: { state: TuiState }): React.JSX.Element {
	const total = state.totalSeries.reduce((a, b) => a + b, 0);
	const estCost = state.tokenSeries.reduce((a, p) => a + p.estCost, 0);
	const span = spanById(state.spanId);
	const { rows } = useTerminalSize();
	const chartH = Math.max(8, Math.min(Math.floor(rows / 2), 14));

  return (
    <Box flexDirection="column">
      <Text bold>
        {isAllTime(span) ? "all-time" : `last ${span.label}`} · {fmtTokens(total)} tok · ${estCost.toFixed(2)}
      </Text>
      <Box marginY={1}>
        <UsageChart data={state.totalSeries} startMs={state.spanWindow.startMs} bucketMs={state.spanWindow.bucketMs} height={chartH} />
      </Box>
      <Text bold color="cyan">
        providers
      </Text>
      {state.overviewRows.length === 0 ? (
        <Text dimColor>no providers enabled — run `amana login &lt;provider&gt;` or `amana sync`</Text>
      ) : (
        state.overviewRows.map((row, i) => {
          const selected = i === state.selection;
          const marker = selected ? "› " : "  ";
          if (row.error) {
            return (
              <Text key={row.provider} color="red">
                {marker}
                {row.label} · {row.error}
              </Text>
            );
          }
          return (
            <Box key={row.provider}>
              <Text bold={selected}>{`${marker}${truncate(row.label, 22).padEnd(23)}`}</Text>
              {row.gauge ? <LineGauge value={row.pct} dot /> : null}
              <Text dimColor>
                {"  "}
                {row.detail}
                {resetsIn(row.resetsAt)}
                {row.live ? "" : " · local"}
              </Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}
