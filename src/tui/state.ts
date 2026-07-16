/**
 * Pure reducer + initialState for the TUI. No side effects, no I/O — just a
 * `useReducer`-friendly function. The data loop in `useRefresh.ts` dispatches
 * `setData` after each refresh; `App.tsx` dispatches everything else in
 * response to keys.
 *
 * Spec: local://tui.md (State section).
 */
import type { UsageReport } from "../usage/types.ts";
import type { FetchError } from "../usage/orchestrator.ts";
import type { ProviderHourly } from "../db/types.ts";

export type Tab = "limits" | "tokens" | "accounts";

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
  reports: UsageReport[];
  errors: FetchError[];
  tokenSeries: ProviderHourly[];
  totalSeries: number[];
  accounts: AccountRow[];
  banner: string | null;
  bannerAt: number | null;
  syncing: boolean;
  helpVisible: boolean;
  span: number;
}

export type Action =
  | { t: "setTab"; tab: Tab }
  | { t: "cycleTab" }
  | { t: "move"; delta: number; count: number }
  | { t: "drillIn"; providerId: string }
  | { t: "back" }
  | {
      t: "setData";
      reports: UsageReport[];
      errors: FetchError[];
      tokenSeries: ProviderHourly[];
      totalSeries: number[];
      accounts: AccountRow[];
    }
  | { t: "setSyncing"; on: boolean }
  | { t: "setBanner"; text: string }
  | { t: "clearBanner" }
  | { t: "toggleHelp" }
  | { t: "cycleSpan" };

const TAB_ORDER: Tab[] = ["limits", "tokens", "accounts"];
const SPAN_CYCLE: number[] = [12, 24, 48];

export function initialState(): TuiState {
  return {
    tab: "tokens",
    drillProvider: null,
    selection: 0,
    reports: [],
    errors: [],
    tokenSeries: [],
    totalSeries: [],
    accounts: [],
    banner: null,
    bannerAt: null,
    syncing: false,
    helpVisible: false,
    span: 24,
  };
}

export function reducer(s: TuiState, a: Action): TuiState {
  switch (a.t) {
    case "setTab":
      if (s.tab === a.tab) return s;
      return { ...s, tab: a.tab, drillProvider: null, selection: 0 };

    case "cycleTab": {
      const idx = TAB_ORDER.indexOf(s.tab);
      const next = TAB_ORDER[(idx + 1) % TAB_ORDER.length]!;
      return { ...s, tab: next, drillProvider: null, selection: 0 };
    }

    case "move": {
      if (a.count <= 0) return { ...s, selection: 0 };
      // Wrap within [0, count). Pure JS `%` already matches the sign of the
      // dividend, so this handles negative deltas correctly.
      const raw = s.selection + a.delta;
      const wrapped = ((raw % a.count) + a.count) % a.count;
      return { ...s, selection: wrapped };
    }

    case "drillIn":
      if (s.drillProvider === a.providerId) return s;
      return { ...s, drillProvider: a.providerId, selection: 0 };

    case "back":
      if (s.drillProvider !== null) {
        return { ...s, drillProvider: null, selection: 0 };
      }
      // Top-level back is the App's quit signal — flag it via the same state
      // shape by clearing nothing; the App's useInput handler treats Esc at
      // top level as exit. Return s unchanged.
      return s;

    case "setData":
      return {
        ...s,
        reports: a.reports,
        errors: a.errors,
        tokenSeries: a.tokenSeries,
        totalSeries: a.totalSeries,
        accounts: a.accounts,
      };

    case "setSyncing":
      if (s.syncing === a.on) return s;
      return { ...s, syncing: a.on };

    case "setBanner":
      return { ...s, banner: a.text, bannerAt: Date.now() };

    case "clearBanner":
      if (s.banner === null && s.bannerAt === null) return s;
      return { ...s, banner: null, bannerAt: null };

    case "toggleHelp":
      return { ...s, helpVisible: !s.helpVisible };

    case "cycleSpan": {
      const idx = SPAN_CYCLE.indexOf(s.span);
      const next = SPAN_CYCLE[(idx + 1) % SPAN_CYCLE.length]!;
      return { ...s, span: next };
    }
  }
}