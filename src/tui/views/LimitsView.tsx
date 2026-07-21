import React from "react";
import { Box, Text } from "ink";
import type { TuiState } from "../state.ts";
import { LineGauge } from "../widgets/LineGauge.tsx";
import { fmtDuration } from "../../report/format.ts";

function resetsIn(resetsAt: number | undefined): string {
  if (resetsAt === undefined) return "";
  const secs = Math.floor((resetsAt - Date.now()) / 1000);
  return secs > 0 ? ` · resets in ${fmtDuration(secs)}` : "";
}

/**
 * Default landing view: every enabled provider's limits, grouped by provider
 * (bold header) and — where a provider has multiple accounts — by account
 * (dim subheader), with a blank line between provider groups so the list reads
 * as sections rather than one dense column. Live quota limits (per account,
 * from `amana login`) render with a gauge + reset; configured token/cost caps
 * and guidance rows render as plain lines. Data rows stay selectable; Enter
 * drills into the provider detail.
 */
export function LimitsView({ state }: { state: TuiState }): React.JSX.Element {
  if (state.limitRows.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold color="cyan">limits</Text>
        <Text dimColor>no providers enabled — run `amana login &lt;provider&gt;` or press p</Text>
      </Box>
    );
  }

  const items: React.JSX.Element[] = [];
  let prevProvider: string | undefined;
  let prevAccount: string | undefined;

  state.limitRows.forEach((row, i) => {
    const selected = i === state.selection;

    if (row.provider !== prevProvider) {
      if (prevProvider !== undefined) items.push(<Text key={`sp-${i}`}> </Text>);
      items.push(<Text key={`hd-${i}`} bold color="cyan">{row.label}</Text>);
      prevProvider = row.provider;
      prevAccount = undefined;
    }

    const hasAccount = !!row.account;
    if (hasAccount && row.account !== prevAccount) {
      items.push(<Text key={`ac-${i}`} dimColor>{`  ${row.account}`}</Text>);
    }
    prevAccount = row.account;

    const indent = hasAccount ? 4 : 2;
    const pad = `${selected ? "›" : " "}${" ".repeat(indent - 1)}`;

    if (row.error) {
      items.push(
        <Text key={`${row.provider}-${i}`} color="red">{`${pad}${row.error}`}</Text>,
      );
      return;
    }

    const trailing =
      `${row.limitLabel} · ${row.detail}${resetsIn(row.resetsAt)}${row.live ? "" : " · local"}`;
    items.push(
      <Box key={`${row.provider}-${i}`}>
        <Text bold={selected}>{pad}</Text>
        {row.gauge ? <LineGauge value={row.pct} dot /> : null}
        <Text dimColor>{row.gauge ? `  ${trailing}` : trailing}</Text>
      </Box>,
    );
  });

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">limits</Text>
      {items}
    </Box>
  );
}
