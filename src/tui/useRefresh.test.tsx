import { test, expect, beforeAll, spyOn } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "span-cache-"));
process.env.ATOP_CONFIG_DIR = dir;
process.env.ATOP_DATA_DIR = dir;
process.env.ATOP_OMP_DIR = join(dir, "omp");
process.env.ATOP_CLAUDE_DIR = join(dir, "claude");

import * as orchestrator from "../usage/orchestrator.ts";
import * as syncMod from "../ingest/sync.ts";

// Dynamic import: App reads config from env at load time, so env must be set first.
const { resolvePaths } = await import("../config/paths.ts");
const { loadConfig } = await import("../config/config.ts");
const { openDb } = await import("../db/db.ts");
const { insertEvents } = await import("../db/usage.ts");
const { App } = await import("./App.tsx");

const paths = resolvePaths();
const cfg = loadConfig(paths.configFile);
const db = openDb(paths.dbFile);

beforeAll(() => {
  const now = Date.now();
  const rows = Array.from({ length: 5 }, (_, i) => ({
    source: "omp",
    source_message_id: `c${i}`,
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

test("span switch is served from cache — no runSync / fetchAll", async () => {
  // Hermetic: mock implementations so the suite never reaches the network or
  // disk sync, even though the temp data dir already has no credentials.
  const fetchSpy = spyOn(orchestrator, "fetchAll").mockImplementation(() =>
    Promise.resolve({ reports: [], errors: [] }),
  );
  const syncSpy = spyOn(syncMod, "runSync").mockImplementation(() => Promise.resolve([]));

  const { lastFrame, stdin, unmount } = render(
    <App db={db} cfg={cfg} dataDir={paths.dataDir} configFile={paths.configFile} />,
  );
  await delay(80);

  const fullFetch = fetchSpy.mock.calls.length;
  const fullSync = syncSpy.mock.calls.length;
  expect(fullFetch).toBe(1);
  expect(fullSync).toBe(1);

  stdin.write("2");
  await delay(30);
  expect(lastFrame() ?? "").toContain("last 24h");

  stdin.write("t");
  await delay(30);
  expect(lastFrame() ?? "").toContain("last 48h");

  stdin.write("t");
  await delay(30);
  expect(lastFrame() ?? "").toContain("last 7d");

  // back to 24h — must hit the warm cache, still no network/ingest
  stdin.write("t");
  await delay(20);
  stdin.write("t");
  await delay(20);
  stdin.write("t");
  await delay(20);
  stdin.write("t");
  await delay(20);
  stdin.write("t");
  await delay(30);
  expect(lastFrame() ?? "").toContain("last 24h");

  expect(fetchSpy.mock.calls.length).toBe(fullFetch);
  expect(syncSpy.mock.calls.length).toBe(fullSync);

  fetchSpy.mockRestore();
  syncSpy.mockRestore();
  unmount();
});
