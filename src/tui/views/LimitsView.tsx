import React from "react";
import { Box, Text } from "ink";
import type { TuiState } from "../state.ts";
import type { LimitRow } from "./derive.ts";
import { LineGauge } from "../widgets/LineGauge.tsx";
import { fmtDuration } from "../../report/format.ts";

function resetsIn(resetsAt: number | undefined): string {
  if (resetsAt === undefined) return "";
  return ` · resets in ${fmtDuration(Math.floor((resetsAt - Date.now()) / 1000))}`;
}

export function LimitsView({
  state,
  rows,
}: {
  state: TuiState;
  rows: LimitRow[];
}): React.JSX.Element {
  if (rows.length === 0) {
    return <Text dimColor>no live usage — run `atop login &lt;provider&gt;` to add accounts</Text>;
  }
  return (
    <Box flexDirection="column">
      {rows.map((row, i) => {
        const selected = i === state.selection;
        const marker = selected ? "> " : "  ";
        if (row.error) {
          return (
            <Text key={row.provider} color="red">
              {marker}
              {row.provider} · {row.account} · {row.error}
            </Text>
          );
        }
        const label = `${marker}${row.provider} · ${row.account} · ${row.label}${resetsIn(row.resetsAt)}`;
        return (
          <Box key={row.provider}>
            <Text bold={selected}>{label} </Text>
            <LineGauge value={row.pct} />
          </Box>
        );
      })}
    </Box>
  );
}
