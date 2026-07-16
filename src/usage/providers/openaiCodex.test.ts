/**
 * Tests for the OpenAI Codex normalize helper. Verifies both field spellings
 * (used_percent vs percent_left, reset_at vs reset_time_ms vs
 * reset_after_seconds) map to the same usedFraction and reset-time shape.
 */
import { describe, expect, test } from "bun:test";
import {
  normalizeEpochMs,
  normalizeWindow,
  type WindowPayload,
} from "./openaiCodex.ts";

const NOW = 1_700_000_000_000;

describe("normalizeEpochMs", () => {
  test("passes ms-shaped epoch through unchanged", () => {
    expect(normalizeEpochMs(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(normalizeEpochMs(-1_700_000_000_000)).toBe(-1_700_000_000_000);
  });

  test("scales sec-shaped epoch up to ms", () => {
    expect(normalizeEpochMs(1_700_000_000)).toBe(1_700_000_000_000);
    expect(normalizeEpochMs(0)).toBe(0);
  });
});

describe("normalizeWindow — primary spelling (used_percent / reset_at in ms)", () => {
  test("clamps usedFraction into [0,1]", () => {
    const w: WindowPayload = { used_percent: 65, reset_at: NOW + 3_600_000 };
    const out = normalizeWindow(w, NOW);
    expect(out.usedFraction).toBeCloseTo(0.65, 9);
    expect(out.resetsAt).toBe(NOW + 3_600_000);
    expect(out.durationMs).toBeUndefined();
  });

  test("used_percent over 100 clamps to 1.0", () => {
    const out = normalizeWindow({ used_percent: 130 }, NOW);
    expect(out.usedFraction).toBe(1);
  });
});

describe("normalizeWindow — alternate spelling (percent_left / reset_time_ms / reset_after_seconds)", () => {
  test("percent_left is inverted to usedFraction", () => {
    const out = normalizeWindow({ percent_left: 40 }, NOW);
    expect(out.usedFraction).toBeCloseTo(0.6, 9);
  });

  test("reset_time_ms is normalized to ms", () => {
    const out = normalizeWindow({ used_percent: 10, reset_time_ms: NOW + 7_200_000 }, NOW);
    expect(out.resetsAt).toBe(NOW + 7_200_000);
  });

  test("reset_after_seconds is computed from now", () => {
    const out = normalizeWindow({ used_percent: 10, reset_after_seconds: 120 }, NOW);
    expect(out.resetsAt).toBe(NOW + 120_000);
  });

  test("reset_at in seconds scales to ms", () => {
    const out = normalizeWindow({ used_percent: 10, reset_at: NOW / 1000 + 600 }, NOW);
    expect(out.resetsAt).toBe(NOW + 600_000);
  });

  test("limit_window_seconds becomes durationMs", () => {
    const out = normalizeWindow({ used_percent: 10, limit_window_seconds: 18_000 }, NOW);
    expect(out.durationMs).toBe(18_000 * 1000);
  });
});

describe("normalizeWindow — absence", () => {
  test("returns empty object for undefined window", () => {
    expect(normalizeWindow(undefined, NOW)).toEqual({});
  });

  test("returns usedFraction undefined when only percent_left absent", () => {
    const out = normalizeWindow({ limit_window_seconds: 60 }, NOW);
    expect(out.usedFraction).toBeUndefined();
    expect(out.durationMs).toBe(60_000);
  });
});