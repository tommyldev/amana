import { test, expect, beforeAll } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "atop-tui-"));
process.env.ATOP_CONFIG_DIR = dir;
process.env.ATOP_DATA_DIR = dir;
process.env.ATOP_OMP_DIR = join(dir, "omp");
process.env.ATOP_CLAUDE_DIR = join(dir, "claude");

const { resolvePaths } = await import("../config/paths.ts");
const { loadConfig } = await import("../config/config.ts");
const { openDb } = await import("../db/db.ts");
const { insertEvents } = await import("../db/usage.ts");
const { initialState } = await import("./state.ts");
const { TokensView } = await import("./views/TokensView.tsx");
const { App } = await import("./App.tsx");

const paths = resolvePaths();
const cfg = loadConfig(paths.configFile);
const db = openDb(paths.dbFile);

beforeAll(() => {
  const now = Date.now();
  const rows = Array.from({ length: 3 }, (_, i) => ({
    source: "omp",
    source_message_id: `t${i}`,
    timestamp_ms: now - i * 3_600_000,
    provider: "anthropic",
    model: "claude-opus-4",
    prompt_tokens: 1000,
    completion_tokens: 500,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    total_tokens: 1500,
    cost_usd: 0.1,
    cost_origin: "logged",
  }));
  insertEvents(db, rows);
});

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

test("TokensView renders 24-bucket header from seeded series", () => {
  const state = { ...initialState(), totalSeries: new Array(24).fill(0).map((_, i) => i * 10), tokenSeries: [
    { provider: "anthropic", buckets: new Array(24).fill(5), totalTokens: 120, estCost: 0.5 },
  ] };
  const { lastFrame } = render(<TokensView state={state} />);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("last 24h");
  expect(frame).toContain("anthropic");
});

test("App tab navigation reaches all three tabs", async () => {
  const { lastFrame, stdin, unmount } = render(<App db={db} cfg={cfg} dataDir={paths.dataDir} />);
  await delay(30);
  expect(lastFrame()).toContain("Tokens");
  expect(lastFrame()).toContain("last 24h");

  stdin.write("1");
  await delay(30);
  expect(lastFrame()).toContain("Limits");

  stdin.write("3");
  await delay(30);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("Accounts");
  expect(frame).toContain("no accounts stored");

  stdin.write("2");
  await delay(30);
  expect(lastFrame()).toContain("last 24h");
  unmount();
});
