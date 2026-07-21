import React from "react";
import { Box, Text } from "ink";
import { heatInk } from "../theme.ts";
import { fmtTokens } from "../../report/format.ts";
import { HOUR_MS, DAY_MS } from "../spans.ts";

const COL = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

export interface UsageChartProps {
  data: number[];
  startMs?: number;
  height?: number;
  labelEvery?: number;
  bucketMs?: number;
}

function hourLabel(ms: number): string {
  return String(new Date(ms).getUTCHours()).padStart(2, "0");
}

function dateLabel(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Multi-row heat bar chart of hourly token usage, the Ink twin of the CLI's
 * `renderHourlyGraph`. Each column is colored by its share of the peak
 * (green → yellow → red) via `heatInk`; axis chrome and labels render dim.
 */
export function UsageChart({ data, startMs, height = 10, labelEvery, bucketMs }: UsageChartProps): React.JSX.Element {
  const bMs = bucketMs ?? HOUR_MS;
  const isDaily = bMs >= DAY_MS;
  const n = data.length;
  const max = n > 0 ? Math.max(...data) : 0;
  if (n === 0) return <Text dimColor>no activity</Text>;

  const gutter = Math.max(fmtTokens(max).length, 4);
  const colColor = data.map((v) => heatInk(max > 0 ? v / max : 0));
  const every = labelEvery ?? (isDaily ? Math.max(5, Math.ceil(n / 10)) : Math.max(3, Math.ceil(n / 12)));
  const rows: React.JSX.Element[] = [];

  for (let row = height - 1; row >= 0; row--) {
    const axisLabel = row === height - 1 ? fmtTokens(max) : row === 0 ? "0" : "";
    const connector = row === 0 ? "┼" : "┤";
    const cells: React.JSX.Element[] = [];
    for (let i = 0; i < n; i++) {
      const eighths = max > 0 ? Math.round((data[i]! / max) * height * 8) : 0;
      const base = row * 8;
      const glyph = eighths >= base + 8 ? "█" : eighths <= base ? " " : COL[eighths - base]!;
      cells.push(
        <Text key={i} color={colColor[i]}>
          {glyph}
        </Text>,
      );
    }
    rows.push(
      <Text key={row}>
        {axisLabel.padStart(gutter)} <Text dimColor>{connector}</Text>
        {cells}
      </Text>,
    );
  }

  let labelRow = " ".repeat(gutter + 2);
  for (let i = 0; i < n; ) {
    if (i % every === 0 && i + 1 < n) {
      const ms = (startMs ?? 0) + i * bMs;
      labelRow += isDaily ? dateLabel(ms) : hourLabel(ms);
      i += 2;
    } else {
      labelRow += " ";
      i += 1;
    }
  }

  return (
    <Box flexDirection="column">
      {rows}
      <Text dimColor>
        {" ".repeat(gutter)} └{"─".repeat(n)}
      </Text>
      {startMs !== undefined ? <Text dimColor>{labelRow}</Text> : null}
    </Box>
  );
}
