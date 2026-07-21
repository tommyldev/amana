import React from "react";
import { Box, Text } from "ink";
import { statusOf } from "../../usage/types.ts";
import { statusColor } from "../theme.ts";

export interface LineGaugeProps {
  value: number;
  width?: number;
  label?: string;
  /** Prefix the bar with a status dot (matches `omp usage`). */
  dot?: boolean;
}

/**
 * Horizontal usage bar in the `omp usage` style: an optional status dot, a
 * status-colored `█` fill over a dim `░` track, and a trailing percent. The
 * fill color follows `statusOf(fraction)` so it agrees with the CLI breakdown.
 */
export function LineGauge({ value, width = 20, label, dot }: LineGaugeProps): React.JSX.Element {
  const pct = Math.max(0, Math.min(100, value));
  const filled = Math.round((pct / 100) * width);
  const color = statusColor[statusOf(pct / 100)];

  return (
    <Box>
      {label ? <Text>{label} </Text> : null}
      {dot ? <Text color={color}>● </Text> : null}
      <Text color={color}>{"█".repeat(filled)}</Text>
      <Text dimColor>{"░".repeat(width - filled)}</Text>
      <Text> {Math.round(pct)}%</Text>
    </Box>
  );
}
