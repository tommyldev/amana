import React from "react";
import { Box, Text } from "ink";
import type { TuiState } from "../state.ts";
import { LineGauge } from "../widgets/LineGauge.tsx";
import { limitPct } from "./derive.ts";
import { colorFor } from "../theme.ts";
import { fmtDuration } from "../../report/format.ts";

function resetsIn(resetsAt: number | undefined): string {
  if (resetsAt === undefined) return "";
  return ` · resets in ${fmtDuration(Math.floor((resetsAt - Date.now()) / 1000))}`;
}

export function LimitsProviderView({ state }: { state: TuiState }): React.JSX.Element {
  const id = state.drillProvider ?? "";
  const reports = state.reports.filter((r) => r.provider === id);
  const errors = state.errors.filter((e) => e.provider === id);

  return (
    <Box flexDirection="column">
      <Text bold color={colorFor(id)}>
        {id}
      </Text>
      {reports.map((r) => (
        <Box key={r.account} flexDirection="column" marginTop={1}>
          <Text bold>{r.account}</Text>
          {r.limits.map((l) => (
            <Box key={l.id}>
              <Text>
                {"  "}
                {l.label}
                {resetsIn(l.window?.resetsAt)}{" "}
              </Text>
              <LineGauge value={limitPct(l)} />
            </Box>
          ))}
        </Box>
      ))}
      {errors.map((e, i) => (
        <Text key={`err-${i}`} color="red">
          {e.account}: {e.message}
        </Text>
      ))}
      {reports.length === 0 && errors.length === 0 ? (
        <Text dimColor>no usage data for {id}</Text>
      ) : null}
    </Box>
  );
}
