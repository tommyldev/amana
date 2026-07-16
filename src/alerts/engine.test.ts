import { describe, expect, test } from "bun:test";
import { openDb } from "../db/db.ts";
import type { AlertsCfg } from "../config/types.ts";
import type { UsageLimit, UsageReport } from "../usage/types.ts";
import { alertAlreadyFired } from "../db/alertState.ts";
import { candidates, checkAndFire } from "./engine.ts";
import { makeLimit, makeReport } from "./_factories.ts";

const cfg: AlertsCfg = { enabled: true, thresholds: [75, 90, 100], desktop: false };

describe("candidates", () => {
  test("emits highest crossed threshold only", () => {
    const r = makeReport([makeLimit({ id: "five_h", label: "5h", usedFraction: 0.93 })]);
    const evts = candidates([r], [75, 90, 100]);
    expect(evts).toHaveLength(1);
    expect(evts[0].threshold).toBe(90);
    expect(evts[0].usedPct).toBeCloseTo(93, 6);
    expect(evts[0].provider).toBe("anthropic");
    expect(evts[0].account).toBe("u1");
    expect(evts[0].limitId).toBe("five_h");
    expect(evts[0].limitLabel).toBe("5h");
  });

  test("returns no event when usedFraction is below the lowest threshold", () => {
    const r = makeReport([makeLimit({ id: "five_h", label: "5h", usedFraction: 0.5 })]);
    expect(candidates([r], [75, 90, 100])).toEqual([]);
  });

  test("skips limits without usedFraction", () => {
    const l: UsageLimit = {
      id: "no_frac",
      label: "unknown",
      scope: { provider: "anthropic", shared: false },
      amount: { unit: "tokens" },
      status: "unknown",
      notes: [],
    };
    expect(candidates([makeReport([l])], [75, 90, 100])).toEqual([]);
  });

  test("emits 100 threshold when fully exhausted", () => {
    const r = makeReport([makeLimit({ id: "five_h", label: "5h", usedFraction: 1.0 })]);
    expect(candidates([r], [75, 90, 100])[0].threshold).toBe(100);
  });

  test("sorts thresholds; accepts them out of order", () => {
    const r = makeReport([makeLimit({ id: "five_h", label: "5h", usedFraction: 0.8 })]);
    expect(candidates([r], [100, 90, 75])[0].threshold).toBe(75);
  });

  test("propagates resetsAt from the limit window", () => {
    const resets = 1_700_000_000_000;
    const r = makeReport([
      makeLimit({ id: "weekly", label: "Weekly", usedFraction: 0.93, resetsAt: resets }),
    ]);
    expect(candidates([r], [90])[0].resetsAt).toBe(resets);
  });

  test("handles multiple limits per report", () => {
    const r = makeReport([
      makeLimit({ id: "a", label: "5h", usedFraction: 0.5 }),
      makeLimit({ id: "b", label: "Weekly", usedFraction: 0.91 }),
      makeLimit({ id: "c", label: "Monthly", usedFraction: 1.1 }),
    ]);
    const evts = candidates([r], [75, 90, 100]);
    expect(evts.map((e) => e.limitId).sort()).toEqual(["b", "c"]);
    expect(evts.find((e) => e.limitId === "b")!.threshold).toBe(90);
    expect(evts.find((e) => e.limitId === "c")!.threshold).toBe(100);
  });
});

describe("checkAndFire", () => {
  test("returns [] when alerts disabled", () => {
    const db = openDb(":memory:");
    const r = makeReport([makeLimit({ id: "five_h", label: "5h", usedFraction: 0.93 })]);
    const fired = checkAndFire(db, { enabled: false, thresholds: [90], desktop: false }, [r]);
    expect(fired).toEqual([]);
    expect(alertAlreadyFired(db, {
      provider: "anthropic", account: "u1", limitId: "five_h", threshold: 90, epoch: "x",
    })).toBe(false);
  });

  test("fires exactly one event for usedFraction 0.93 at threshold 90", () => {
    const db = openDb(":memory:");
    const resets = 1_700_000_000_000;
    const r = makeReport([
      makeLimit({ id: "five_h", label: "5h", usedFraction: 0.93, resetsAt: resets }),
    ]);
    const fired = checkAndFire(db, cfg, [r]);
    expect(fired).toHaveLength(1);
    expect(fired[0].threshold).toBe(90);
    expect(fired[0].usedPct).toBeCloseTo(93, 6);
    expect(fired[0].resetsAt).toBe(resets);
  });

  test("a second call returns [] (dedup within the same epoch)", () => {
    const db = openDb(":memory:");
    const resets = 1_700_000_000_000;
    const r = makeReport([
      makeLimit({ id: "five_h", label: "5h", usedFraction: 0.93, resetsAt: resets }),
    ]);
    expect(checkAndFire(db, cfg, [r])).toHaveLength(1);
    expect(checkAndFire(db, cfg, [r])).toHaveLength(0);
    expect(checkAndFire(db, cfg, [r])).toHaveLength(0);
  });

  test("re-fires when resetsAt changes (new epoch)", () => {
    const db = openDb(":memory:");
    const resets1 = 1_700_000_000_000;
    const resets2 = 1_700_003_600_000; // +1 hour, different hour bucket
    const r1 = makeReport([
      makeLimit({ id: "five_h", label: "5h", usedFraction: 0.93, resetsAt: resets1 }),
    ]);
    expect(checkAndFire(db, cfg, [r1])).toHaveLength(1);
    const r2 = makeReport([
      makeLimit({ id: "five_h", label: "5h", usedFraction: 0.93, resetsAt: resets2 }),
    ]);
    expect(checkAndFire(db, cfg, [r2])).toHaveLength(1);
  });

  test("does NOT re-fire when resetsAt jitters within the same hour bucket", () => {
    const db = openDb(":memory:");
    const base = 1_700_000_000_000;
    const jitter = base + 5_000; // +5s, same hour bucket
    const r1 = makeReport([
      makeLimit({ id: "five_h", label: "5h", usedFraction: 0.93, resetsAt: base }),
    ]);
    expect(checkAndFire(db, cfg, [r1])).toHaveLength(1);
    const r2 = makeReport([
      makeLimit({ id: "five_h", label: "5h", usedFraction: 0.93, resetsAt: jitter }),
    ]);
    expect(checkAndFire(db, cfg, [r2])).toHaveLength(0);
  });

  test("re-fires after a new threshold is crossed", () => {
    const db = openDb(":memory:");
    const resets = 1_700_000_000_000;
    const r93 = makeReport([
      makeLimit({ id: "five_h", label: "5h", usedFraction: 0.93, resetsAt: resets }),
    ]);
    expect(checkAndFire(db, cfg, [r93])).toHaveLength(1);
    const r99 = makeReport([
      makeLimit({ id: "five_h", label: "5h", usedFraction: 0.99, resetsAt: resets }),
    ]);
    expect(checkAndFire(db, cfg, [r99])).toHaveLength(0);
    const r101 = makeReport([
      makeLimit({ id: "five_h", label: "5h", usedFraction: 1.01, resetsAt: resets }),
    ]);
    const fired101 = checkAndFire(db, cfg, [r101]);
    expect(fired101).toHaveLength(1);
    expect(fired101[0].threshold).toBe(100);
  });

  test("different accounts / providers are independent dedup keys", () => {
    const db = openDb(":memory:");
    const resets = 1_700_000_000_000;
    const rA = makeReport(
      [makeLimit({ id: "five_h", label: "5h", usedFraction: 0.93, resetsAt: resets })],
      "alice",
    );
    const rB = makeReport(
      [makeLimit({ id: "five_h", label: "5h", usedFraction: 0.93, resetsAt: resets })],
      "bob",
    );
    expect(checkAndFire(db, cfg, [rA])).toHaveLength(1);
    const rAOpenai: UsageReport = {
      provider: "openai-codex",
      account: "alice",
      fetchedAt: Date.now(),
      limits: [makeLimit({ id: "five_h", label: "5h", usedFraction: 0.93, resetsAt: resets })],
      notes: [],
    };
    expect(checkAndFire(db, cfg, [rAOpenai])).toHaveLength(1);
    expect(checkAndFire(db, cfg, [rB])).toHaveLength(1);
  });

  test("limit without resetsAt dedups by UTC date", () => {
    const db = openDb(":memory:");
    const r = makeReport([makeLimit({ id: "five_h", label: "5h", usedFraction: 0.93 })]);
    expect(checkAndFire(db, cfg, [r])).toHaveLength(1);
    expect(checkAndFire(db, cfg, [r])).toHaveLength(0);
  });
});