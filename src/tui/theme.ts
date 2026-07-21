import { KNOWN_PROVIDERS } from "../registry.ts";
import type { UsageStatus } from "../usage/types.ts";
import { type HeatLevel, heatLevel } from "../report/graph.ts";

/** Ink color name per usage status, mirroring the CLI breakdown palette. */
export const statusColor: Record<UsageStatus, string> = {
  exhausted: "red",
  warning: "yellow",
  ok: "green",
  unknown: "gray",
};

/** Ink color name per heat band, matching the CLI graph's ANSI ramp. */
const HEAT_INK: Record<HeatLevel, string> = {
  hot: "red",
  busy: "yellow",
  calm: "green",
  idle: "gray",
};

export function heatInk(ratio: number): string {
  return HEAT_INK[heatLevel(ratio)];
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
