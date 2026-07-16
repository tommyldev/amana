import React, { useEffect, useMemo, useReducer } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { Database } from "bun:sqlite";
import type { Config } from "../config/types.ts";
import { initialState, reducer, type Tab, type TuiState } from "./state.ts";
import { useRefresh } from "./useRefresh.ts";
import { deriveLimitRows, type LimitRow } from "./views/derive.ts";
import { Tabs } from "./widgets/Tabs.tsx";
import { Footer } from "./widgets/Footer.tsx";
import { HelpOverlay } from "./widgets/HelpOverlay.tsx";
import { TokensView } from "./views/TokensView.tsx";
import { TokensProviderView } from "./views/TokensProviderView.tsx";
import { LimitsView } from "./views/LimitsView.tsx";
import { LimitsProviderView } from "./views/LimitsProviderView.tsx";
import { AccountsView } from "./views/AccountsView.tsx";

const TAB_LABELS: { tab: Tab; label: string }[] = [
  { tab: "limits", label: "Limits" },
  { tab: "tokens", label: "Tokens" },
  { tab: "accounts", label: "Accounts" },
];

const BANNER_TTL_MS = 60_000;

export function App({ db, cfg, dataDir }: { db: Database; cfg: Config; dataDir: string }): React.JSX.Element {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const { exit } = useApp();
  const refresh = useRefresh({ db, cfg, dataDir, span: state.span, dispatch });

  const limitRows = useMemo(() => deriveLimitRows(state.reports, state.errors), [state.reports, state.errors]);

  const drilled = state.drillProvider !== null;
  const count = drilled
    ? 0
    : state.tab === "tokens"
      ? state.tokenSeries.length
      : state.tab === "limits"
        ? limitRows.length
        : state.accounts.length;
  const drillId =
    state.tab === "tokens"
      ? state.tokenSeries[state.selection]?.provider
      : state.tab === "limits"
        ? limitRows[state.selection]?.provider
        : undefined;

  useEffect(() => {
    if (state.bannerAt === null) return;
    const timer = setTimeout(() => dispatch({ t: "clearBanner" }), BANNER_TTL_MS);
    return () => clearTimeout(timer);
  }, [state.bannerAt]);

  useInput((input, key) => {
    if (state.helpVisible) {
      if (input === "?" || input === "h" || key.escape) dispatch({ t: "toggleHelp" });
      return;
    }
    if (input === "q" || (key.ctrl && input === "c")) return exit();
    if (input === "?" || input === "h") return dispatch({ t: "toggleHelp" });
    if (input === "1") return dispatch({ t: "setTab", tab: "limits" });
    if (input === "2") return dispatch({ t: "setTab", tab: "tokens" });
    if (input === "3") return dispatch({ t: "setTab", tab: "accounts" });
    if (key.tab) return dispatch({ t: "cycleTab" });
    if (input === "r") return refresh();
    if (input === "x") return dispatch({ t: "clearBanner" });
    if (input === "t" && state.tab === "tokens") return dispatch({ t: "cycleSpan" });
    if (key.upArrow || input === "k") return dispatch({ t: "move", delta: -1, count });
    if (key.downArrow || input === "j") return dispatch({ t: "move", delta: 1, count });
    if (key.return || key.rightArrow || input === "l") {
      if (!drilled && drillId) dispatch({ t: "drillIn", providerId: drillId });
      return;
    }
    if (key.escape) return drilled ? dispatch({ t: "back" }) : exit();
    if (key.leftArrow || key.backspace) {
      if (drilled) dispatch({ t: "back" });
    }
  });

  const activeTab = TAB_LABELS.findIndex((t) => t.tab === state.tab);
  const footer = footerPairs(state.tab, drilled);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Tabs tabs={TAB_LABELS.map((t) => t.label)} active={activeTab} />
        {state.syncing ? <Text dimColor>syncing…</Text> : null}
      </Box>
      {state.banner ? (
        <Text color="red" bold>
          {state.banner}
        </Text>
      ) : null}
      <Box marginY={1}>{renderView(state, db, limitRows)}</Box>
      <Footer pairs={footer} />
      <HelpOverlay visible={state.helpVisible} />
    </Box>
  );
}

function renderView(state: TuiState, db: Database, limitRows: LimitRow[]): React.JSX.Element {
  if (state.tab === "tokens") {
    return state.drillProvider ? <TokensProviderView state={state} db={db} /> : <TokensView state={state} />;
  }
  if (state.tab === "limits") {
    return state.drillProvider ? <LimitsProviderView state={state} /> : <LimitsView state={state} rows={limitRows} />;
  }
  return <AccountsView state={state} />;
}

function footerPairs(tab: Tab, drilled: boolean): [string, string][] {
  const base: [string, string][] = drilled
    ? [["Esc/←", "back"], ["r", "refresh"], ["?", "help"], ["q", "quit"]]
    : [["1/2/3", "tabs"], ["↑↓", "select"], ["Enter", "drill"], ["r", "refresh"], ["?", "help"], ["q", "quit"]];
  if (tab === "tokens") base.splice(base.length - 2, 0, ["t", "span"]);
  return base;
}
