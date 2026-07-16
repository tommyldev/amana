import { fmtTokens } from "./format.ts";

/** Eighth-height column glyphs; index 0 = empty, 8 = full cell. */
const COL = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

const HOUR_MS = 3_600_000;

function hourLabel(ms: number): string {
  return String(new Date(ms).getUTCHours()).padStart(2, "0");
}

/**
 * Render a multi-row vertical bar chart of hourly values (the token-usage
 * rate: tokens per hour). `buckets[i]` is the total for the hour starting at
 * `startMs + i*3600000`. Produces a y-axis (peak + 0), block bars scaled to
 * the peak, an x-axis, and UTC hour labels every `labelEvery` columns.
 */
export function renderHourlyGraph(
  buckets: number[],
  startMs: number,
  height = 6,
  labelEvery = 3,
): string {
  const n = buckets.length;
  const max = n > 0 ? Math.max(...buckets) : 0;
  const gutter = Math.max(fmtTokens(max).length, 4);
  const lines: string[] = [];

  for (let row = height - 1; row >= 0; row--) {
    const axisLabel = row === height - 1 ? fmtTokens(max) : row === 0 ? "0" : "";
    const connector = row === 0 ? "┼" : "┤";
    let line = axisLabel.padStart(gutter) + " " + connector;
    for (const v of buckets) {
      const eighths = max > 0 ? Math.round((v / max) * height * 8) : 0;
      const base = row * 8;
      if (eighths >= base + 8) line += "█";
      else if (eighths <= base) line += " ";
      else line += COL[eighths - base];
    }
    lines.push(line);
  }

  lines.push(" ".repeat(gutter) + " └" + "─".repeat(n));

  let labelRow = " ".repeat(gutter + 2);
  for (let i = 0; i < n; ) {
    if (i % labelEvery === 0 && i + 1 < n) {
      labelRow += hourLabel(startMs + i * HOUR_MS);
      i += 2;
    } else {
      labelRow += " ";
      i += 1;
    }
  }
  lines.push(labelRow);

  return lines.join("\n");
}
