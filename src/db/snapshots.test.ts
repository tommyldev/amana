/**
 * snapshotDeltaSeries turns recorded per-poll `used` totals into a per-bucket
 * consumption rate. The cases that matter: monotonic increase within a reset
 * window, window resets (used drops), idle gaps, multiple windows of one
 * provider (elementwise max, not sum), and the unit/provider filters used by
 * the overview total vs. provider drill-in.
 */
import { describe, expect, test } from "bun:test";
import { openDb } from "./db.ts";
import { recordSnapshots, pruneSnapshots, snapshotDeltaSeries, snapshotLevelSeries } from "./snapshots.ts";
import type { UsageReport, UsageUnit } from "../usage/types.ts";
// Wed 2026-01-14 12:00 UTC.
const T0 = Date.UTC(2026, 0, 14, 12, 0, 0);
const HOUR = 3_600_000;
const MIN = 60_000;

function report(
  provider: string,
  limitId: string,
  unit: UsageUnit,
  fetchedAt: number,
  used: number,
  resetsAt = T0 + 7 * 24 * HOUR,
  limitAmount = 1_000_000,
): UsageReport {
  return {
    provider,
    account: "acct",
    fetchedAt,
    notes: [],
    limits: [
      {
        id: limitId,
        label: limitId,
        scope: { provider, shared: true },
        amount: { used, limit: limitAmount, unit },
        status: "ok",
        notes: [],
        window: { id: "w", label: "w", resetsAt },
      },
    ],
  };
}

function recs(...rs: UsageReport[]): UsageReport[] {
  return rs;
}

describe("recordSnapshots", () => {
  test("skips limits without a finite numeric used", () => {
    const db = openDb(":memory:");
    const r: UsageReport = {
      provider: "zai",
      account: "a",
      fetchedAt: T0,
      notes: [],
      limits: [
        {
          id: "zai:tokens",
          label: "tok",
          scope: { provider: "zai", shared: true },
          amount: { usedFraction: 0.5, unit: "percent" }, // no `used`
          status: "ok",
          notes: [],
        },
      ],
    };
    expect(recordSnapshots(db, recs(r))).toBe(0);
    db.close();
  });

  test("writes one row per numeric limit", () => {
    const db = openDb(":memory:");
    expect(recordSnapshots(db, recs(report("zai", "zai:tokens", "tokens", T0, 100)))).toBe(1);
    expect(
      db.query("SELECT used, unit, resets_at_ms FROM usage_snapshots").get(),
    ).toEqual({ used: 100, unit: "tokens", resets_at_ms: T0 + 7 * 24 * HOUR });
    db.close();
  });
});

describe("snapshotDeltaSeries", () => {
  test("monotonic used within a window yields per-bucket deltas", () => {
    const db = openDb(":memory:");
    // Poll every minute; used climbs 0→60 over the first hour (60 tok), flat in hour 2.
    const polls: UsageReport[] = [];
    for (let m = 0; m < 60; m++) polls.push(report("zai", "zai:tokens", "tokens", T0 + m * MIN, m * 10));
    for (let m = 60; m < 120; m++) polls.push(report("zai", "zai:tokens", "tokens", T0 + m * MIN, 600));
    recordSnapshots(db, polls);
    const series = snapshotDeltaSeries(db, T0, T0 + 2 * HOUR, { buckets: 2 });
    // Hour 1: 59 intra-hour deltas of 10 = 590. The 59→60min delta (10) lands at the hour boundary in bucket 1; hour 2 otherwise flat.
    expect(series).toEqual([590, 10]);
    db.close();
  });

  test("a reset (used drops) does not produce a negative delta and resumes cleanly", () => {
    const db = openDb(":memory:");
    const resetsA = T0 + 2 * HOUR;
    recordSnapshots(
      db,
      recs(
        report("zai", "zai:tokens", "tokens", T0, 100, resetsA),
        report("zai", "zai:tokens", "tokens", T0 + 30 * MIN, 200, resetsA), // +100 in bucket 0
        // Window resets here: new resetsAt, used falls to 0.
        report("zai", "zai:tokens", "tokens", T0 + 70 * MIN, 0, resetsA + HOUR),
        report("zai", "zai:tokens", "tokens", T0 + 90 * MIN, 50, resetsA + HOUR), // +50 in bucket 1
      ),
    );
    const series = snapshotDeltaSeries(db, T0, T0 + 2 * HOUR, { buckets: 2, maxGapMs: 2 * HOUR });
    expect(series).toEqual([100, 50]);
    db.close();
  });

  test("drops deltas that span an idle gap larger than maxGapMs", () => {
    const db = openDb(":memory:");
    recordSnapshots(
      db,
      recs(
        report("zai", "zai:tokens", "tokens", T0, 100),
        report("zai", "zai:tokens", "tokens", T0 + 30 * MIN, 200), // +100, gap 30min > 10min default → dropped
      ),
    );
    const series = snapshotDeltaSeries(db, T0, T0 + HOUR, { buckets: 1 });
    expect(series).toEqual([0]);
    db.close();
  });

  test("two windows of one provider take elementwise max, not sum", () => {
    const db = openDb(":memory:");
    const resetsA = T0 + 2 * HOUR;
    recordSnapshots(
      db,
      recs(
        report("zai", "zai:5h", "tokens", T0, 0, resetsA),
        report("zai", "zai:5h", "tokens", T0 + 30 * MIN, 300, resetsA), // +300
        report("zai", "zai:7d", "tokens", T0, 0, resetsA),
        report("zai", "zai:7d", "tokens", T0 + 30 * MIN, 100, resetsA), // +100
      ),
    );
    const series = snapshotDeltaSeries(db, T0, T0 + HOUR, { buckets: 1, maxGapMs: HOUR });
    // max(300, 100) = 300, not 400.
    expect(series).toEqual([300]);
    db.close();
  });

  test("provider filter scopes to one provider; unit filter excludes others", () => {
    const db = openDb(":memory:");
    const resetsA = T0 + 2 * HOUR;
    recordSnapshots(
      db,
      recs(
        report("zai", "zai:tokens", "tokens", T0, 0, resetsA),
        report("zai", "zai:tokens", "tokens", T0 + 30 * MIN, 250, resetsA),
        report("anthropic", "anthropic:5h", "percent", T0, 0, resetsA),
        report("anthropic", "anthropic:5h", "percent", T0 + 30 * MIN, 10, resetsA), // +10 pp
      ),
    );
    // unit=tokens → only zai.
    expect(
      snapshotDeltaSeries(db, T0, T0 + HOUR, { buckets: 1, unit: "tokens", maxGapMs: HOUR }),
    ).toEqual([250]);
    // provider=anthropic → native unit (percent).
    expect(
      snapshotDeltaSeries(db, T0, T0 + HOUR, { buckets: 1, provider: "anthropic", maxGapMs: HOUR }),
    ).toEqual([10]);
    // excludeProviders drops zai, but anthropic is percent so unit=tokens still excludes it.
    expect(
      snapshotDeltaSeries(db, T0, T0 + HOUR, {
        buckets: 1,
        unit: "tokens",
        excludeProviders: new Set(["zai"]),
        maxGapMs: HOUR,
      }),
    ).toEqual([0]);
    db.close();
  });

  test("two providers sum into the total", () => {
    const db = openDb(":memory:");
    const resetsA = T0 + 2 * HOUR;
    recordSnapshots(
      db,
      recs(
        report("zai", "zai:tokens", "tokens", T0, 0, resetsA),
        report("zai", "zai:tokens", "tokens", T0 + 30 * MIN, 100, resetsA),
        report("google", "g:tokens", "tokens", T0, 0, resetsA),
        report("google", "g:tokens", "tokens", T0 + 30 * MIN, 40, resetsA),
      ),
    );
    expect(
      snapshotDeltaSeries(db, T0, T0 + HOUR, { buckets: 1, unit: "tokens", maxGapMs: HOUR }),
    ).toEqual([140]);
    db.close();
  });
});

describe("pruneSnapshots", () => {
  test("removes only rows older than the cutoff", () => {
    const db = openDb(":memory:");
    recordSnapshots(
      db,
      recs(
        report("zai", "zai:tokens", "tokens", T0, 1),
        report("zai", "zai:tokens", "tokens", T0 + 10 * MIN, 2),
      ),
    );
    expect(pruneSnapshots(db, T0 + 5 * MIN)).toBe(1);
    expect(db.query("SELECT COUNT(*) AS n FROM usage_snapshots").get()).toEqual({ n: 1 });
    db.close();
  });
});

describe("snapshotLevelSeries", () => {
  test("returns null when the provider has no snapshots", () => {
    const db = openDb(":memory:");
    expect(snapshotLevelSeries(db, T0, T0 + HOUR, "zai", 1)).toBeNull();
    db.close();
  });

  test("charts the most binding window's used ramp, last sample per bucket", () => {
    const db = openDb(":memory:");
    const resetsA = T0 + 5 * HOUR;
    recordSnapshots(
      db,
      recs(
        // 5h window at 80% (800/1000) — most binding, should be picked.
        report("anthropic", "anthropic:5h", "percent", T0 + 10 * MIN, 40, resetsA, 100),
        report("anthropic", "anthropic:5h", "percent", T0 + 50 * MIN, 55, resetsA, 100),
        report("anthropic", "anthropic:5h", "percent", T0 + 70 * MIN, 80, resetsA, 100),
        // 7d window at 20% — less binding.
        report("anthropic", "anthropic:7d", "percent", T0 + 70 * MIN, 20, resetsA, 100),
      ),
    );
    const level = snapshotLevelSeries(db, T0, T0 + 2 * HOUR, "anthropic", 2);
    expect(level).not.toBeNull();
    // Bucket 0: last 5h sample in hour 1 is 55 (T0+50min). Bucket 1: 80.
    expect(level!.series).toEqual([55, 80]);
    expect(level!.unit).toBe("percent");
    expect(level!.latestUsed).toBe(80);
    expect(level!.latestLimit).toBe(100);
    db.close();
  });
});
