// `bucketGlyph` uses the `GLYPHS` table below for vertical bar scaling.
import React from "react";
import { Box, Text } from "ink";

const GLYPHS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

export interface BarChartProps {
  data: number[];
  color?: string;
  startMs?: number;
  labelEvery?: number;
}

function bucketGlyph(value: number, max: number): string {
  if (max <= 0 || value <= 0) return GLYPHS[0]!;
  const ratio = value / max;
  const idx = Math.min(GLYPHS.length - 1, Math.max(1, Math.round(ratio * (GLYPHS.length - 1))));
  return GLYPHS[idx]!;
}

function hourLabel(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  return hh;
}

export function BarChart({
  data,
  color = "cyan",
  startMs,
  labelEvery = 3,
}: BarChartProps): React.JSX.Element {
  const max = data.length === 0 ? 0 : Math.max(...data);
  const bars = data.map((v) => bucketGlyph(v, max)).join("");

  const hourRow = (() => {
    if (startMs === undefined || data.length === 0) return "";
    const cells: string[] = [];
    for (let i = 0; i < data.length; i++) {
      const isLabelCol = i % labelEvery === 0;
      cells.push(isLabelCol ? hourLabel(startMs + i * 3_600_000) : " ");
    }
    return cells.join("");
  })();

  return (
    <Box flexDirection="column">
      <Text color={color}>{bars}</Text>
      {hourRow ? <Text dimColor>{hourRow}</Text> : null}
    </Box>
  );
}
