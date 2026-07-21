/**
 * Pure reducer + initialState tests. No React, no I/O.
 * Covers every Action branch and the invariants App + useRefresh rely on.
 */
import { describe, expect, test } from "bun:test";
import { initialState, reducer, SETTINGS_FIELDS } from "./state.ts";
import type { TuiState } from "./state.ts";
import type { AlertsCfg } from "../config/types.ts";
import type { OverviewRow } from "./views/derive.ts";

const ALERTS: AlertsCfg = { enabled: true, thresholds: [75, 90, 100], desktop: true };
const init = () => initialState(ALERTS);

function row(provider: string, pct: number): OverviewRow {
  return { provider, label: provider, pct, status: "ok", detail: "", live: false, gauge: false };
}

describe("initialState", () => {
  test("lands on Overview, span 24, settings seeded from alerts", () => {
    const s = init();
    expect(s.tab).toBe("limits");
    expect(s.drillProvider).toBeNull();
    expect(s.span).toBe(24);
    expect(s.settings).toEqual({ enabled: true, thresholds: [75, 90, 100], desktop: true });
    expect(s.overviewRows).toEqual([]);
  });

  test("copies the thresholds array (no shared mutation)", () => {
    const s = init();
    s.settings.thresholds.push(50);
    expect(ALERTS.thresholds).toEqual([75, 90, 100]);
  });
});

describe("tab navigation", () => {
  test("cycleTab cycles limits → overview → settings → limits", () => {
    let s = reducer(init(), { t: "cycleTab" });
    expect(s.tab).toBe("overview");
    s = reducer(s, { t: "cycleTab" });
    expect(s.tab).toBe("settings");
    expect(reducer(s, { t: "cycleTab" }).tab).toBe("limits");
  });

  test("setTab clears drill + selection + editing", () => {
    let s: TuiState = { ...init(), drillProvider: "anthropic", selection: 3, editing: true };
    s = reducer(s, { t: "setTab", tab: "settings" });
    expect(s.tab).toBe("settings");
    expect(s.drillProvider).toBeNull();
    expect(s.selection).toBe(0);
    expect(s.editing).toBe(false);
  });
});

describe("move (overview selection)", () => {
  test("wraps within [0, count)", () => {
    const s = init();
    expect(reducer(s, { t: "move", delta: -1, count: 3 }).selection).toBe(2);
    expect(reducer({ ...s, selection: 2 }, { t: "move", delta: 1, count: 3 }).selection).toBe(0);
  });
  test("count<=0 pins selection to 0", () => {
    expect(reducer({ ...init(), selection: 5 }, { t: "move", delta: 1, count: 0 }).selection).toBe(0);
  });
});

describe("drillIn / back", () => {
  test("drillIn sets provider; back clears it", () => {
    let s = reducer(init(), { t: "drillIn", providerId: "zai" });
    expect(s.drillProvider).toBe("zai");
    s = reducer(s, { t: "back" });
    expect(s.drillProvider).toBeNull();
  });
  test("back at top level is a no-op (App treats it as quit)", () => {
    const s = init();
    expect(reducer(s, { t: "back" })).toBe(s);
  });
});

describe("cycleSpan", () => {
  test("cycles 24 → 48 → 12 → 24", () => {
    let s = init();
    s = reducer(s, { t: "cycleSpan" });
    expect(s.span).toBe(48);
    s = reducer(s, { t: "cycleSpan" });
    expect(s.span).toBe(12);
    expect(reducer(s, { t: "cycleSpan" }).span).toBe(24);
  });
});

describe("setData", () => {
  test("replaces overviewRows and series", () => {
    const s = reducer(init(), {
      t: "setData",
      overviewRows: [row("anthropic", 50)],
      reports: [],
      errors: [],
      tokenSeries: [],
      limitRows: [],
      totalSeries: [1, 2, 3],
      accounts: [],
    });
    expect(s.overviewRows).toHaveLength(1);
    expect(s.totalSeries).toEqual([1, 2, 3]);
  });
});

describe("banner / syncing / help", () => {
  test("setBanner then clearBanner", () => {
    let s = reducer(init(), { t: "setBanner", text: "hi" });
    expect(s.banner).toBe("hi");
    expect(s.bannerAt).not.toBeNull();
    s = reducer(s, { t: "clearBanner" });
    expect(s.banner).toBeNull();
  });
  test("setSyncing is idempotent by value", () => {
    const s = init();
    expect(reducer(s, { t: "setSyncing", on: false })).toBe(s);
    expect(reducer(s, { t: "setSyncing", on: true }).syncing).toBe(true);
  });
  test("toggleHelp flips", () => {
    expect(reducer(init(), { t: "toggleHelp" }).helpVisible).toBe(true);
  });
});

describe("settings", () => {
  test("settingsMove wraps across the field list and exits editing", () => {
    const s = reducer({ ...init(), editing: true }, { t: "settingsMove", delta: -1 });
    expect(s.settingsSel).toBe(SETTINGS_FIELDS.length - 1);
    expect(s.editing).toBe(false);
  });

  test("settingsToggle flips enabled (row 0) and desktop (row 1)", () => {
    let s = reducer(init(), { t: "settingsToggle" });
    expect(s.settings.enabled).toBe(false);
    s = reducer({ ...init(), settingsSel: 1 }, { t: "settingsToggle" });
    expect(s.settings.desktop).toBe(false);
  });

  test("threshold edit: start → type → commit parses, dedups, sorts", () => {
    let s = { ...init(), settingsSel: 2 };
    s = reducer(s, { t: "editStart" });
    expect(s.editing).toBe(true);
    expect(s.editBuffer).toBe("75,90,100");
    // Replace with a fresh set.
    s = { ...s, editBuffer: "" };
    for (const ch of "90,50,90") s = reducer(s, { t: "editChar", ch });
    s = reducer(s, { t: "editBackspace" });
    expect(s.editBuffer).toBe("90,50,9");
    s = reducer({ ...s, editBuffer: "90,50,90" }, { t: "editCommit" });
    expect(s.editing).toBe(false);
    expect(s.settings.thresholds).toEqual([50, 90]);
  });

  test("editStart only fires on the thresholds row", () => {
    const s = reducer({ ...init(), settingsSel: 0 }, { t: "editStart" });
    expect(s.editing).toBe(false);
  });

  test("editCommit with no valid numbers keeps previous thresholds", () => {
    let s = { ...init(), settingsSel: 2, editing: true, editBuffer: "abc" };
    s = reducer(s, { t: "editCommit" });
    expect(s.settings.thresholds).toEqual([75, 90, 100]);
  });

  test("editChar ignores non digit/comma; editCancel drops the buffer", () => {
    let s = { ...init(), editing: true, editBuffer: "7" };
    s = reducer(s, { t: "editChar", ch: "x" });
    expect(s.editBuffer).toBe("7");
    s = reducer(s, { t: "editCancel" });
    expect(s.editing).toBe(false);
    expect(s.editBuffer).toBe("");
  });
});
