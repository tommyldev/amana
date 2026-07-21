import { fmtTokens } from "./format.ts";
import { dim, green, red, yellow } from "./ansi.ts";

/** Eighth-height column glyphs; index 0 = empty, 8 = full cell. */
const COL = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

const HOUR_MS = 3_600_000;

function hourLabel(ms: number): string {
  return String(new Date(ms).getUTCHours()).padStart(2, "0");
}

/** Intensity band of a bar column by its share of the peak. */
export type HeatLevel = "idle" | "calm" | "busy" | "hot";

export function heatLevel(ratio: number): HeatLevel {
  if (ratio >= 0.8) return "hot";
  if (ratio >= 0.45) return "busy";
  if (ratio > 0) return "calm";
  return "idle";
}

const HEAT_ANSI: Record<HeatLevel, (t: string) => string> = {
  hot: red,
  busy: yellow,
  calm: green,
  idle: dim,
};

/**
 * Heat color fn for a column ratio: green (calm) → yellow (busy) → red (hot),
 * dim when idle. Shared threshold source with the TUI chart via {@link heatLevel}.
 */
export function heatColor(ratio: number): (t: string) => string {
  return HEAT_ANSI[heatLevel(ratio)];
}

/**
 * Render a multi-row vertical bar chart of hourly values (the token-usage
 * rate: tokens per hour). `buckets[i]` is the total for the hour starting at
 * `startMs + i*3600000`. Produces a y-axis (peak + 0), block bars scaled to
 * the peak, an x-axis, and UTC hour labels every `labelEvery` columns. Bars
 * are heat-colored per column; axis chrome and labels render dim.
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
  const colColor = buckets.map((v) => heatColor(max > 0 ? v / max : 0));
  const lines: string[] = [];

  for (let row = height - 1; row >= 0; row--) {
    const axisLabel = row === height - 1 ? fmtTokens(max) : row === 0 ? "0" : "";
    const connector = row === 0 ? "┼" : "┤";
    let line = axisLabel.padStart(gutter) + " " + dim(connector);
    for (let i = 0; i < n; i++) {
      const eighths = max > 0 ? Math.round((buckets[i]! / max) * height * 8) : 0;
      const base = row * 8;
      if (eighths >= base + 8) line += colColor[i]!("█");
      else if (eighths <= base) line += " ";
      else line += colColor[i]!(COL[eighths - base]!);
    }
    lines.push(line);
  }

  lines.push(" ".repeat(gutter) + " " + dim("└" + "─".repeat(n)));

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
  lines.push(dim(labelRow));

  return lines.join("\n");
}
