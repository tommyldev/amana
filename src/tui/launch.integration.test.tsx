import { test, expect, spyOn } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "launch-int-"));
process.env.ATOP_CONFIG_DIR = dir;
process.env.ATOP_DATA_DIR = dir;
process.env.ATOP_OMP_DIR = join(dir, "omp");
process.env.ATOP_CLAUDE_DIR = join(dir, "claude");

import * as orchestrator from "../usage/orchestrator.ts";
import type { FetchResult } from "../usage/orchestrator.ts";
import * as syncMod from "../ingest/sync.ts";
import { launchCacheFile } from "../config/paths.ts";

// Dynamic import: App reads config from env at load time, so env must be set first.
const { resolvePaths } = await import("../config/paths.ts");
const { loadConfig } = await import("../config/config.ts");
const { openDb } = await import("../db/db.ts");
const { App } = await import("./App.tsx");

const paths = resolvePaths();
const cfg = loadConfig(paths.configFile);
const db = openDb(paths.dbFile);

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

test("opening with a launch cache paints previous stats before the network resolves", async () => {
  // Seed a prior session: 7d span + a recognizable account + token total.
  writeFileSync(
    launchCacheFile(paths.dataDir),
    JSON.stringify({
      savedAt: Date.now(),
      spanId: "7d",
      spanWindow: { startMs: 1, endMs: 2, bucketMs: 86_400_000, buckets: 7 },
      overviewRows: [],
      limitRows: [],
      reports: [],
      errors: [],
      tokenSeries: [{ provider: "anthropic", buckets: [100, 200, 300, 0, 0, 0, 0], totalTokens: 600, estCost: 1.25 }],
      totalSeries: [100, 200, 300, 0, 0, 0, 0],
      accounts: [{ provider: "anthropic", label: "cached-acct", kind: "oauth", expiry: "in 1h" }],
    }),
    { mode: 0o600 },
  );

  const fetchSpy = spyOn(orchestrator, "fetchAll").mockImplementation(
    () => Promise.withResolvers<FetchResult>().promise,
  );
  spyOn(syncMod, "runSync").mockImplementation(() => Promise.resolve([]));

  const { lastFrame, stdin, unmount } = render(
    <App db={db} cfg={cfg} dataDir={paths.dataDir} configFile={paths.configFile} />,
  );
  await delay(30);

  // The dashboard must already show the previous session — no waiting on fetchAll.
  stdin.write("2");
  await delay(20);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("last 7d");
  expect(frame).toContain("600 tok");
  expect(frame).toContain("$1.25");
  expect(fetchSpy.mock.calls.length).toBe(1); // a refresh was kicked off but isn't blocking paint

  fetchSpy.mockRestore();
  (syncMod.runSync as unknown as { mockRestore: () => void }).mockRestore?.();
  unmount();
});
