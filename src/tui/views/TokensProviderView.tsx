import React from "react";
import { Box, Text } from "ink";
import type { Database } from "bun:sqlite";
import type { TuiState } from "../state.ts";
import { BarChart } from "../widgets/BarChart.tsx";
import { Table } from "../widgets/Table.tsx";
import { breakdownByModel } from "../../db/breakdown.ts";
import { sourcesFor } from "../../report/snapshot.ts";
import { byId } from "../../registry.ts";
import { colorFor } from "../theme.ts";
import { fmtTokens } from "../../report/format.ts";

const HOUR_MS = 3_600_000;

export function TokensProviderView({
  state,
  db,
}: {
  state: TuiState;
  db: Database;
}): React.JSX.Element {
  const id = state.drillProvider ?? "";
  const series = state.tokenSeries.find((p) => p.provider === id);
  const startMs = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - (state.span - 1) * HOUR_MS;
  const endMs = startMs + state.span * HOUR_MS;
  const models = breakdownByModel(db, startMs, endMs, sourcesFor(id), byId(id)?.ompProvider ?? undefined);

  const rows = models.map((m) => [
    m.model,
    String(m.requests),
    fmtTokens(m.total_tokens),
    `$${m.cost.toFixed(2)}`,
  ]);

  return (
    <Box flexDirection="column">
      <Text bold color={colorFor(id)}>
        {id} · last {state.span}h · {fmtTokens(series?.totalTokens ?? 0)} tok
      </Text>
      <Box marginY={1}>
        <BarChart data={series?.buckets ?? []} startMs={startMs} color={colorFor(id)} />
      </Box>
      {rows.length > 0 ? (
        <Table
          columns={[
            { header: "model", width: 30 },
            { header: "reqs", width: 6, align: "right" },
            { header: "tokens", width: 9, align: "right" },
            { header: "est $", width: 9, align: "right" },
          ]}
          rows={rows}
        />
      ) : (
        <Text dimColor>no model activity for {id} in the last {state.span}h</Text>
      )}
    </Box>
  );
}
