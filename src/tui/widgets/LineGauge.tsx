import React from "react";
import { Box, Text } from "ink";
import { gaugeColor } from "../theme.ts";

export interface LineGaugeProps {
  value: number;
  width?: number;
  label?: string;
}

export function LineGauge({ value, width = 12, label }: LineGaugeProps): React.JSX.Element {
  const pct = Math.max(0, Math.min(100, value));
  const filled = Math.round((pct / 100) * width);
  const empty = Math.max(0, width - filled);
  const bar = "█".repeat(filled) + "░".repeat(empty);
  const color = gaugeColor(pct);

  return (
    <Box>
      {label ? <Text>{label} </Text> : null}
      <Text color={color}>[{bar}]</Text>
      <Text> {pct}%</Text>
    </Box>
  );
}
