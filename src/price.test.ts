import { test, expect } from "bun:test";
import { cost } from "./price.ts";

test("sonnet prices in + out per mtok", () => {
  expect(cost("claude-3-5-sonnet-20240620", 1_000_000, 1_000_000)).toBeCloseTo(18.0, 9);
});

test("opus prices", () => {
  expect(cost("claude-3-opus-20240229", 1_000_000, 1_000_000)).toBeCloseTo(90.0, 9);
});

test("haiku prices scale with token counts", () => {
  expect(cost("claude-3-haiku-20240307", 2_000_000, 1_000_000)).toBeCloseTo(1.75, 9);
});

test("unknown model returns undefined", () => {
  expect(cost("mystery-model-v9", 100, 100)).toBeUndefined();
});

test("first-match ordering: 3-5-sonnet before generic patterns", () => {
  expect(cost("claude-sonnet-4-20250101", 1_000_000, 0)).toBeCloseTo(3.0, 9);
});

test("cache read bills at 0.1x the input rate", () => {
  // sonnet input = $3/Mtok → 1M cache-read tokens = $0.30.
  expect(cost("claude-3-5-sonnet-20240620", 0, 0, 1_000_000, 0)).toBeCloseTo(0.3, 9);
});

test("cache write bills at 1.25x the input rate", () => {
  // sonnet input = $3/Mtok → 1M cache-write tokens = $3.75.
  expect(cost("claude-3-5-sonnet-20240620", 0, 0, 0, 1_000_000)).toBeCloseTo(3.75, 9);
});

test("cache tokens add to prompt+completion cost", () => {
  const blind = cost("claude-3-5-sonnet-20240620", 100_000, 10_000)!;
  const withCache = cost("claude-3-5-sonnet-20240620", 100_000, 10_000, 500_000, 200_000)!;
  expect(withCache).toBeGreaterThan(blind);
  // + 500k read @0.3/Mtok*... = 0.5*3*0.1=0.15 ; 200k write = 0.2*3*1.25=0.75.
  expect(withCache - blind).toBeCloseTo(0.15 + 0.75, 9);
});

test("three-arg calls are unchanged (cache defaults to 0)", () => {
  expect(cost("claude-3-5-sonnet-20240620", 1_000_000, 1_000_000)).toBeCloseTo(18.0, 9);
});

test("claude-3-7-sonnet prices at $3/$15 per Mtok (was unpriced)", () => {
  expect(cost("claude-3-7-sonnet-20250219", 1_000_000, 1_000_000)).toBeCloseTo(18.0, 9);
  expect(cost("claude-3-7-sonnet-20250219", 1_000_000, 0)).toBeCloseTo(3.0, 9);
});
