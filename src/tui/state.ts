/**
 * Pure reducer + initialState for the TUI. No side effects, no I/O. The data
 * loop in `useRefresh.ts` dispatches `setData`; `App.tsx` dispatches key
 * actions. Three views: Overview (all providers + aggregate chart), a Provider
 * drill-in, and Settings (editable alerts).
 */
import type { AlertsCfg } from "../config/types.ts";
import type { UsageReport } from "../usage/types.ts";
import type { FetchError } from "../usage/orchestrator.ts";
import type { ProviderHourly } from "../db/types.ts";
import type { OverviewRow } from "./views/derive.ts";
import type { LimitRow } from "./views/limitRows.ts";
import { DEFAULT_SPAN_ID, nextSpanId, spanById, spanWindow, type SpanWindow } from "./spans.ts";
import type { LaunchCache } from "./launchCache.ts";

export type Tab = "limits" | "overview" | "settings";

/** Settings rows, in display order. 0/1 toggle, 2 edits, 3 is an action. */
export const SETTINGS_FIELDS = ["enabled", "desktop", "thresholds", "test"] as const;

export interface AccountRow {
  provider: string;
  label: string;
  kind: string;
  expiry: string;
  error?: string;
}

export interface TuiState {
  tab: Tab;
  drillProvider: string | null;
  selection: number;
  overviewRows: OverviewRow[];
  limitRows: LimitRow[];
  reports: UsageReport[];
  errors: FetchError[];
  tokenSeries: ProviderHourly[];
  totalSeries: number[];
  accounts: AccountRow[];
  banner: string | null;
  bannerAt: number | null;
  syncing: boolean;
  dataTick: number;
  helpVisible: boolean;
  spanId: string;
  spanWindow: SpanWindow;
  settings: { enabled: boolean; desktop: boolean; thresholds: number[] };
  settingsSel: number;
  editing: boolean;
  editBuffer: string;
}

export type Action =
  | { t: "setTab"; tab: Tab }
  | { t: "cycleTab" }
  | { t: "move"; delta: number; count: number }
  | { t: "drillIn"; providerId: string }
  | { t: "back" }
  | {
      t: "setData";
      overviewRows: OverviewRow[];
      limitRows: LimitRow[];
      reports: UsageReport[];
      errors: FetchError[];
      tokenSeries: ProviderHourly[];
      totalSeries: number[];
      spanWindow: SpanWindow;
      accounts: AccountRow[];
    }
  | { t: "setSyncing"; on: boolean }
  | { t: "setBanner"; text: string }
  | { t: "clearBanner" }
  | { t: "toggleHelp" }
  | { t: "cycleSpan" }
  | { t: "settingsMove"; delta: number }
  | { t: "settingsToggle" }
  | { t: "editStart" }
  | { t: "editChar"; ch: string }
  | { t: "editBackspace" }
  | { t: "editCommit" }
  | { t: "editCancel" };


export function initialState(alerts: AlertsCfg, launch?: LaunchCache | null): TuiState {
  const base: TuiState = {
    tab: "limits",
    drillProvider: null,
    selection: 0,
    overviewRows: launch?.overviewRows ?? [],
    limitRows: launch?.limitRows ?? [],
    reports: launch?.reports ?? [],
    errors: launch?.errors ?? [],
    tokenSeries: launch?.tokenSeries ?? [],
    totalSeries: launch?.totalSeries ?? [],
    accounts: launch?.accounts ?? [],
    banner: null,
    bannerAt: null,
    syncing: false,
    dataTick: 0,
    helpVisible: false,
    spanId: launch?.spanId ?? DEFAULT_SPAN_ID,
    spanWindow: launch?.spanWindow ?? spanWindow(spanById(DEFAULT_SPAN_ID), Date.now()),
    settings: { enabled: alerts.enabled, desktop: alerts.desktop, thresholds: [...alerts.thresholds] },
    settingsSel: 0,
    editing: false,
    editBuffer: "",
  };
  return base;
}

/** Parse a CSV of ints in 1..100, deduped and sorted; empty → keep previous. */
function parseThresholds(buffer: string, previous: number[]): number[] {
  const parsed: number[] = [];
  for (const part of buffer.split(",")) {
    const n = Number.parseInt(part.trim(), 10);
    if (Number.isFinite(n) && n >= 1 && n <= 100) parsed.push(n);
  }
  if (parsed.length === 0) return previous;
  return [...new Set(parsed)].sort((a, b) => a - b);
}

export function reducer(s: TuiState, a: Action): TuiState {
  switch (a.t) {
    case "setTab":
      if (s.tab === a.tab && s.drillProvider === null) return s;
      return { ...s, tab: a.tab, drillProvider: null, selection: 0, editing: false };

    case "cycleTab": {
      const order: Tab[] = ["limits", "overview", "settings"];
      const next = order[(order.indexOf(s.tab) + 1) % order.length]!;
      return { ...s, tab: next, drillProvider: null, selection: 0, editing: false };
    }

    case "move": {
      if (a.count <= 0) return { ...s, selection: 0 };
      const raw = s.selection + a.delta;
      return { ...s, selection: ((raw % a.count) + a.count) % a.count };
    }

    case "drillIn":
      if (s.drillProvider === a.providerId) return s;
      return { ...s, drillProvider: a.providerId };

    case "back":
      if (s.drillProvider !== null) return { ...s, drillProvider: null };
      return s;

    case "setData":
      return {
        ...s,
        overviewRows: a.overviewRows,
        limitRows: a.limitRows,
        reports: a.reports,
        errors: a.errors,
        tokenSeries: a.tokenSeries,
        totalSeries: a.totalSeries,
        spanWindow: a.spanWindow,
        accounts: a.accounts,
        dataTick: s.dataTick + 1,
      };

    case "setSyncing":
      return s.syncing === a.on ? s : { ...s, syncing: a.on };

    case "setBanner":
      return { ...s, banner: a.text, bannerAt: Date.now() };

    case "clearBanner":
      return s.banner === null && s.bannerAt === null ? s : { ...s, banner: null, bannerAt: null };

    case "toggleHelp":
      return { ...s, helpVisible: !s.helpVisible };

    case "cycleSpan":
      return { ...s, spanId: nextSpanId(s.spanId) };

    case "settingsMove": {
      const raw = s.settingsSel + a.delta;
      const wrapped = ((raw % SETTINGS_FIELDS.length) + SETTINGS_FIELDS.length) % SETTINGS_FIELDS.length;
      return { ...s, settingsSel: wrapped, editing: false };
    }

    case "settingsToggle": {
      if (s.settingsSel === 0) return { ...s, settings: { ...s.settings, enabled: !s.settings.enabled } };
      if (s.settingsSel === 1) return { ...s, settings: { ...s.settings, desktop: !s.settings.desktop } };
      return s;
    }

    case "editStart":
      if (s.settingsSel !== 2) return s;
      return { ...s, editing: true, editBuffer: s.settings.thresholds.join(",") };

    case "editChar":
      if (!s.editing || !/^[0-9,]$/.test(a.ch)) return s;
      return { ...s, editBuffer: s.editBuffer + a.ch };

    case "editBackspace":
      return s.editing ? { ...s, editBuffer: s.editBuffer.slice(0, -1) } : s;

    case "editCommit": {
      if (!s.editing) return s;
      const thresholds = parseThresholds(s.editBuffer, s.settings.thresholds);
      return { ...s, editing: false, editBuffer: "", settings: { ...s.settings, thresholds } };
    }

    case "editCancel":
      return s.editing ? { ...s, editing: false, editBuffer: "" } : s;
  }
}
