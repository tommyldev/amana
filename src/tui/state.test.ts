/**
 * Pure reducer + initialState tests. No React, no I/O.
 * Covers every Action branch and the invariants the App + useRefresh rely on.
 */
import { describe, expect, test } from "bun:test";
import { initialState, reducer, type AccountRow } from "./state.ts";
import type { TuiState, Tab } from "./state.ts";
import type { UsageReport } from "../usage/types.ts";

function emptyReport(): UsageReport {
  return { provider: "test", account: "acc", fetchedAt: 0, limits: [], notes: [] };
}

describe("initialState", () => {
  test("lands on tab 'tokens' with span 24 and empty collections", () => {
    const s = initialState();
    expect(s.tab).toBe("tokens");
    expect(s.span).toBe(24);
    expect(s.drillProvider).toBeNull();
    expect(s.selection).toBe(0);
    expect(s.reports).toEqual([]);
    expect(s.errors).toEqual([]);
    expect(s.tokenSeries).toEqual([]);
    expect(s.totalSeries).toEqual([]);
    expect(s.accounts).toEqual([]);
    expect(s.banner).toBeNull();
    expect(s.bannerAt).toBeNull();
    expect(s.syncing).toBe(false);
    expect(s.helpVisible).toBe(false);
  });

  test("returns a fresh object on each call (mutable safety)", () => {
    const a = initialState();
    const b = initialState();
    expect(a).not.toBe(b);
    a.tab = "limits";
    expect(b.tab).toBe("tokens");
  });
});

describe("cycleTab", () => {
  test("reaches all three tabs and wraps", () => {
    let s = initialState();
    expect(s.tab).toBe("tokens");
    s = reducer(s, { t: "cycleTab" });
    expect(s.tab).toBe("accounts");
    s = reducer(s, { t: "cycleTab" });
    expect(s.tab).toBe("limits");
    s = reducer(s, { t: "cycleTab" });
    expect(s.tab).toBe("tokens");
  });

  test("resets drillProvider and selection on cycle", () => {
    let s: TuiState = { ...initialState(), drillProvider: "openai-codex", selection: 3 };
    s = reducer(s, { t: "cycleTab" });
    expect(s.drillProvider).toBeNull();
    expect(s.selection).toBe(0);
  });
});

describe("setTab", () => {
  test("switches tabs and resets drillProvider + selection", () => {
    let s: TuiState = { ...initialState(), drillProvider: "anthropic", selection: 2 };
    s = reducer(s, { t: "setTab", tab: "accounts" });
    expect(s.tab).toBe("accounts");
    expect(s.drillProvider).toBeNull();
    expect(s.selection).toBe(0);
  });

  test("no-op when target tab matches current", () => {
    const s = initialState();
    const next = reducer(s, { t: "setTab", tab: "tokens" });
    expect(next).toBe(s);
  });
});

describe("move", () => {
  test("wraps at both ends given a count", () => {
    const start = initialState();
    const atTop = reducer(start, { t: "move", delta: -1, count: 3 });
    expect(atTop.selection).toBe(2); // -1 wraps to last
    const atBottom = reducer(start, { t: "move", delta: 3, count: 3 });
    expect(atBottom.selection).toBe(0); // +3 wraps to 0
    const mid = reducer({ ...start, selection: 1 }, { t: "move", delta: 1, count: 3 });
    expect(mid.selection).toBe(2);
  });

  test("count=0 collapses selection to 0", () => {
    const s: TuiState = { ...initialState(), selection: 5 };
    expect(reducer(s, { t: "move", delta: 1, count: 0 }).selection).toBe(0);
  });

  test("count=1 keeps selection at 0 for any delta", () => {
    const s = initialState();
    expect(reducer(s, { t: "move", delta: 7, count: 1 }).selection).toBe(0);
    expect(reducer(s, { t: "move", delta: -3, count: 1 }).selection).toBe(0);
  });
});

describe("drillIn / back", () => {
  test("drillIn sets provider and resets selection", () => {
    let s: TuiState = { ...initialState(), selection: 4 };
    s = reducer(s, { t: "drillIn", providerId: "openai-codex" });
    expect(s.drillProvider).toBe("openai-codex");
    expect(s.selection).toBe(0);
  });

  test("drillIn + move + back returns to a clean top-level state", () => {
    let s = reducer(initialState(), { t: "drillIn", providerId: "anthropic" });
    s = reducer(s, { t: "move", delta: 2, count: 4 });
    expect(s.selection).toBe(2);
    s = reducer(s, { t: "back" });
    expect(s.drillProvider).toBeNull();
    expect(s.selection).toBe(0);
    expect(reducer(s, { t: "back" })).toBe(s);
  });

});

describe("cycleSpan", () => {
  test("cycles 12 → 24 → 48 → 12", () => {
    let s = initialState();
    expect(s.span).toBe(24);
    s = reducer(s, { t: "cycleSpan" });
    expect(s.span).toBe(48);
    s = reducer(s, { t: "cycleSpan" });
    expect(s.span).toBe(12);
    s = reducer(s, { t: "cycleSpan" });
    expect(s.span).toBe(24);
  });
});

describe("setBanner / clearBanner", () => {
  test("setBanner sets banner text and bannerAt to a recent epoch ms", () => {
    const before = Date.now();
    const s = reducer(initialState(), { t: "setBanner", text: "⚠ something at 90% (≥90%)" });
    expect(s.banner).toBe("⚠ something at 90% (≥90%)");
    expect(s.bannerAt).not.toBeNull();
    expect(s.bannerAt!).toBeGreaterThanOrEqual(before);
    expect(s.bannerAt!).toBeLessThanOrEqual(Date.now());
  });

  test("clearBanner nulls banner and bannerAt (and is a no-op when already clear)", () => {
    const withBanner = reducer(initialState(), { t: "setBanner", text: "x" });
    const cleared = reducer(withBanner, { t: "clearBanner" });
    expect(cleared.banner).toBeNull();
    expect(cleared.bannerAt).toBeNull();
    expect(reducer(initialState(), { t: "clearBanner" })).toEqual(initialState());
  });

});

describe("setData", () => {
  test("populates arrays atomically", () => {
    const accounts: AccountRow[] = [
      { provider: "anthropic", label: "a@x", kind: "oauth", expiry: "in 42m" },
    ];
    const s = reducer(initialState(), {
      t: "setData",
      reports: [emptyReport()],
      errors: [{ provider: "zai", account: "k", message: "boom" }],
      tokenSeries: [{ provider: "anthropic", buckets: [1, 2, 3], totalTokens: 6, estCost: 0.1 }],
      totalSeries: [1, 2, 3],
      accounts,
    });
    expect(s.reports).toHaveLength(1);
    expect(s.errors).toHaveLength(1);
    expect(s.errors[0]?.message).toBe("boom");
    expect(s.tokenSeries[0]?.provider).toBe("anthropic");
    expect(s.totalSeries).toEqual([1, 2, 3]);
    expect(s.accounts).toBe(accounts);
  });
});

describe("setSyncing", () => {
  test("toggles syncing flag and is a no-op when already in target state", () => {
    const s0 = initialState();
    const s1 = reducer(s0, { t: "setSyncing", on: true });
    expect(s1.syncing).toBe(true);
    expect(reducer(s1, { t: "setSyncing", on: true })).toBe(s1);
    const s2 = reducer(s1, { t: "setSyncing", on: false });
    expect(s2.syncing).toBe(false);
  });
});

describe("toggleHelp", () => {
  test("flips helpVisible", () => {
    const s0 = initialState();
    const s1 = reducer(s0, { t: "toggleHelp" });
    expect(s1.helpVisible).toBe(true);
    expect(reducer(s1, { t: "toggleHelp" }).helpVisible).toBe(false);
  });
});
