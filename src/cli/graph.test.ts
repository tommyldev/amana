/**
 * providerSeries scopes a graph to a provider by log SOURCE (+ omp `provider`
 * filter), so aggregate ids resolve real data and omp- vs claude-code-sourced
 * `anthropic` events never bleed together — the bug behind an empty
 * `graph --provider claude-code`.
 */
import { describe, expect, test } from "bun:test";
import { openDb } from "../db/db.ts";
import { insertEvents } from "../db/usage.ts";
import type { UsageEventRow } from "../db/types.ts";
import { providerSeries } from "./graph.ts";

const HOUR = 3_600_000;
const NOW = Date.now();
const SPAN = 24;
const START = Math.floor(NOW / HOUR) * HOUR - (SPAN - 1) * HOUR;
const END = START + SPAN * HOUR;

function ev(source: string, provider: string, total: number): UsageEventRow {
  return {
    source, source_message_id: `${source}-${provider}-${total}`, timestamp_ms: NOW - 60_000,
    provider, model: "m", prompt_tokens: total, completion_tokens: 0,
    cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: total, cost_usd: 1, cost_origin: "logged",
  };
}

function seeded() {
  const db = openDb(":memory:");
  insertEvents(db, [
    ev("claude-code", "anthropic", 500), // claude-code source
    ev("omp", "anthropic", 300),          // omp source, provider anthropic
    ev("omp", "minimax-code", 100),       // omp source, other provider
  ]);
  return db;
}

describe("providerSeries scoping", () => {
  test("claude-code resolves its own source (not omp anthropic)", () => {
    expect(providerSeries(seeded(), "claude-code", START, END, SPAN).total).toBe(500);
  });

  test("anthropic resolves omp-sourced anthropic only (not claude-code)", () => {
    expect(providerSeries(seeded(), "anthropic", START, END, SPAN).total).toBe(300);
  });

  test("omp aggregate sums every omp-source event", () => {
    expect(providerSeries(seeded(), "omp", START, END, SPAN).total).toBe(400);
  });

  test("buckets span the window and sum to the total", () => {
    const s = providerSeries(seeded(), "omp", START, END, SPAN);
    expect(s.buckets).toHaveLength(SPAN);
    expect(s.buckets.reduce((a, b) => a + b, 0)).toBe(s.total);
  });
});
