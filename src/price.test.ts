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
