import { KNOWN_PROVIDERS } from "../registry.ts";

/** Color band for usage gauges: <70 green, 70..90 yellow, >=90 red. */
export function gaugeColor(pct: number): string {
  if (pct >= 90) return "red";
  if (pct >= 70) return "yellow";
  return "green";
}

/**
 * Per-provider color band (ink/chalk names) cycled so each row/chart is
 * visually distinct. Indexed by the provider's position in KNOWN_PROVIDERS so
 * the color is stable across runs. Port of `theme.rs::PALETTE`.
 */
export const PALETTE: string[] = [
  "cyan",
  "green",
  "yellow",
  "magenta",
  "blue",
  "redBright",
  "cyanBright",
  "greenBright",
  "yellowBright",
  "magentaBright",
  "blueBright",
  "red",
];

export function colorFor(id: string): string {
  let idx = KNOWN_PROVIDERS.findIndex((p) => p.id === id);
  if (idx < 0) {
    let sum = 0;
    for (const b of Buffer.from(id, "utf8")) sum += b;
    idx = sum;
  }
  return PALETTE[idx % PALETTE.length]!;
}
