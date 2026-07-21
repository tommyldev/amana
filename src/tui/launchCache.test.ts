import { test, expect, describe } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLaunchCache, writeLaunchCache, type LaunchCache } from "./launchCache.ts";

const dir = () => mkdtempSync(join(tmpdir(), "launch-cache-"));

const sample: LaunchCache = {
  savedAt: 1_700_000_000_000,
  spanId: "7d",
  spanWindow: { startMs: 1, endMs: 2, bucketMs: 3_600_000, buckets: 42 },
  overviewRows: [],
  limitRows: [],
  reports: [],
  errors: [],
  tokenSeries: [{ provider: "anthropic", buckets: [10, 20], totalTokens: 30, estCost: 0.5 }],
  totalSeries: [10, 20],
  accounts: [{ provider: "anthropic", label: "acct", kind: "oauth", expiry: "in 1h" }],
};

describe("launch cache", () => {
  test("write then read round-trips the payload", () => {
    const d = dir();
    expect(readLaunchCache(d)).toBeNull();
    writeLaunchCache(d, sample);
    const back = readLaunchCache(d);
    expect(back).not.toBeNull();
    expect(back!.spanId).toBe("7d");
    expect(back!.totalSeries).toEqual([10, 20]);
    expect(back!.tokenSeries).toHaveLength(1);
    expect(back!.tokenSeries[0]!.provider).toBe("anthropic");
    expect(back!.accounts[0]!.expiry).toBe("in 1h");
  });

  test("a corrupt cache file yields null, never a throw", () => {
    const d = dir();
    const { writeFileSync } = require("node:fs");
    const { launchCacheFile } = require("../config/paths.ts");
    writeFileSync(launchCacheFile(d), "{ not json", { mode: 0o600 });
    expect(readLaunchCache(d)).toBeNull();
  });

  test("a structurally-invalid cache (no spanId) is rejected", () => {
    const d = dir();
    const { writeFileSync } = require("node:fs");
    const { launchCacheFile } = require("../config/paths.ts");
    writeFileSync(launchCacheFile(d), JSON.stringify({ totalSeries: [1] }), { mode: 0o600 });
    expect(readLaunchCache(d)).toBeNull();
  });
});
