import React from "react";
import { Box, Text } from "ink";
import type { TuiState } from "../state.ts";
import { BarChart } from "../widgets/BarChart.tsx";
import { Table } from "../widgets/Table.tsx";
import { fmtTokens } from "../../report/format.ts";

const HOUR_MS = 3_600_000;

export function TokensView({ state }: { state: TuiState }): React.JSX.Element {
  const total = state.totalSeries.reduce((a, b) => a + b, 0);
  const estCost = state.tokenSeries.reduce((a, p) => a + p.estCost, 0);
  const startMs = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - (state.span - 1) * HOUR_MS;

  const rows = state.tokenSeries.map((p) => [
    p.provider,
    fmtTokens(p.totalTokens),
    `$${p.estCost.toFixed(2)}`,
    total > 0 ? `${Math.round((p.totalTokens / total) * 100)}%` : "0%",
  ]);

  return (
    <Box flexDirection="column">
      <Text bold>
        last {state.span}h · {fmtTokens(total)} tok · ${estCost.toFixed(2)}
      </Text>
      <Box marginY={1}>
        <BarChart data={state.totalSeries} startMs={startMs} color="cyan" />
      </Box>
      {rows.length > 0 ? (
        <Table
          columns={[
            { header: "provider", width: 22 },
            { header: "tokens", width: 9, align: "right" },
            { header: "est $", width: 9, align: "right" },
            { header: "share", width: 6, align: "right" },
          ]}
          rows={rows}
          selected={state.selection}
        />
      ) : (
        <Text dimColor>no token activity in the last {state.span}h</Text>
      )}
    </Box>
  );
}
