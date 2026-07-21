import React, { useEffect, useReducer } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { Database } from "bun:sqlite";
import type { Config } from "../config/types.ts";
import { saveConfig } from "../config/config.ts";
import { notify } from "../alerts/notify.ts";
import { initialState, reducer, type Tab, type TuiState } from "./state.ts";
import { readLaunchCache } from "./launchCache.ts";
import { useRefresh } from "./useRefresh.ts";
import { useTerminalSize } from "./useTerminalSize.ts";
import { Tabs } from "./widgets/Tabs.tsx";
import { Footer } from "./widgets/Footer.tsx";
import { HelpOverlay } from "./widgets/HelpOverlay.tsx";
import { OverviewView } from "./views/OverviewView.tsx";
import { ProviderView } from "./views/ProviderView.tsx";
import { SettingsView } from "./views/SettingsView.tsx";
import { LimitsView } from "./views/LimitsView.tsx";
import { ProvidersView } from "./views/ProvidersView.tsx";
import { useProviderLogin } from "./login/useProviderLogin.ts";
import type { LoginRequest } from "./login/perform.ts";

const TABS: { tab: Tab; label: string }[] = [
  { tab: "limits", label: "Limits" },
  { tab: "overview", label: "Overview" },
  { tab: "settings", label: "Settings" },
];
const BANNER_TTL_MS = 60_000;

export function App({
  db,
  cfg,
  dataDir,
  configFile,
  reopenProvider,
}: {
  db: Database;
  cfg: Config;
  dataDir: string;
  configFile: string;
  onLogin?: (req: LoginRequest) => void;
  reopenProvider?: string;
}): React.JSX.Element {
  const [state, dispatch] = useReducer(
    reducer,
    { alerts: cfg.alerts, dataDir },
    ({ alerts, dataDir }) => initialState(alerts, readLaunchCache(dataDir)),
  );
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const refresh = useRefresh({ db, cfg, dataDir, spanId: state.spanId, dispatch });
  const providerLogin = useProviderLogin({ db, cfg, configFile, dataDir, accounts: state.accounts, refresh, dispatch });

  useEffect(() => {
    if (reopenProvider) providerLogin.openDetail(reopenProvider);
  }, [reopenProvider]);

  const drilled = state.drillProvider !== null;
  const listRows = state.tab === "limits" ? state.limitRows : state.overviewRows;
  const count = listRows.length;
  const selectedId = listRows[state.selection]?.provider;

  useEffect(() => {
    if (state.bannerAt === null) return;
    const timer = setTimeout(() => dispatch({ t: "clearBanner" }), BANNER_TTL_MS);
    return () => clearTimeout(timer);
  }, [state.bannerAt]);

  // Persist alert settings to config.toml (and the live cfg the refresh loop reads).
  useEffect(() => {
    cfg.alerts.enabled = state.settings.enabled;
    cfg.alerts.desktop = state.settings.desktop;
    cfg.alerts.thresholds = [...state.settings.thresholds];
    saveConfig(configFile, cfg);
  }, [state.settings, cfg, configFile]);

  useInput((input, key) => {
    if (state.helpVisible) {
      if (input === "?" || input === "h" || key.escape) dispatch({ t: "toggleHelp" });
      return;
    }
    if (providerLogin.active) {
      providerLogin.handleInput(input, key);
      return;
    }
    if (state.tab === "settings" && state.editing) {
      if (key.return) return dispatch({ t: "editCommit" });
      if (key.escape) return dispatch({ t: "editCancel" });
      if (key.backspace || key.delete) return dispatch({ t: "editBackspace" });
      if (input && /^[0-9,]$/.test(input)) return dispatch({ t: "editChar", ch: input });
      return;
    }
    if (input === "q" || (key.ctrl && input === "c")) return exit();
    if (input === "?" || input === "h") return dispatch({ t: "toggleHelp" });
    if (input === "1") return dispatch({ t: "setTab", tab: "limits" });
    if (input === "2") return dispatch({ t: "setTab", tab: "overview" });
    if (input === "3") return dispatch({ t: "setTab", tab: "settings" });
    if (key.tab) return dispatch({ t: "cycleTab" });
    if (key.leftArrow || key.rightArrow) {
      const order: Tab[] = ["limits", "overview", "settings"];
      const idx = order.indexOf(state.tab);
      const dir = key.rightArrow ? 1 : -1;
      return dispatch({ t: "setTab", tab: order[(idx + dir + order.length) % order.length]! });
    }
    if (input === "r") return refresh();
    if (input === "x") return dispatch({ t: "clearBanner" });
    if (input === "p") return providerLogin.open();

    if (state.tab === "settings") {
      if (key.upArrow || input === "k") return dispatch({ t: "settingsMove", delta: -1 });
      if (key.downArrow || input === "j") return dispatch({ t: "settingsMove", delta: 1 });
      if (key.return) {
        if (state.settingsSel === 2) return dispatch({ t: "editStart" });
        if (state.settingsSel === 3) {
          notify("Agent Mana: test alert", "This is a test notification from Agent Mana settings");
          return dispatch({ t: "setBanner", text: "test notification sent" });
        }
        return dispatch({ t: "settingsToggle" });
      }
      if (input === " ") return dispatch({ t: "settingsToggle" });
      return;
    }

    // overview / provider detail
    if (input === "t") return dispatch({ t: "cycleSpan" });
    if (drilled) {
      if (key.escape) dispatch({ t: "back" });
      return;
    }
    if (key.upArrow || input === "k") return dispatch({ t: "move", delta: -1, count });
    if (key.downArrow || input === "j") return dispatch({ t: "move", delta: 1, count });
    if (key.return) {
      if (selectedId) dispatch({ t: "drillIn", providerId: selectedId });
      return;
    }
    if (key.escape) return exit();
  });

  const activeTab = TABS.findIndex((t) => t.tab === state.tab);

  return (
    <Box flexDirection="column" width={columns} height={rows} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box justifyContent="space-between">
        <Box flexDirection="column">
          <Box>
            <Text bold color="cyan">Agent Mana </Text>
            <Text dimColor>monitor your model usage</Text>
          </Box>
          <Box>
            <Tabs tabs={TABS.map((t) => t.label)} active={activeTab} />
            {drilled ? <Text dimColor> › {state.drillProvider}</Text> : null}
          </Box>
        </Box>
        {state.syncing ? <Text dimColor>syncing…</Text> : null}
      </Box>
      {state.banner ? <Text color="red" bold>{state.banner}</Text> : null}
      <Box flexGrow={1} flexDirection="column" marginTop={1}>
        {providerLogin.login ? (
          <ProvidersView login={providerLogin.login} accounts={state.accounts} />
        ) : state.helpVisible ? (
          <HelpOverlay visible />
        ) : (
          renderView(state, db)
        )}
      </Box>
      <Footer pairs={footerPairs(state, drilled)} />
    </Box>
  );
}

function renderView(state: TuiState, db: Database): React.JSX.Element {
  if (state.tab === "settings") return <SettingsView state={state} />;
  if (state.drillProvider !== null) return <ProviderView state={state} db={db} />;
  if (state.tab === "overview") return <OverviewView state={state} />;
  return <LimitsView state={state} />;
}

function footerPairs(state: TuiState, drilled: boolean): [string, string][] {
  if (state.tab === "settings") {
    return [["←/→/1-3", "view"], ["↑↓", "move"], ["Space", "toggle"], ["Enter", "edit"], ["p", "providers"], ["?", "help"], ["q", "quit"]];
  }
  if (drilled) {
    return [["Esc", "back"], ["←/→", "view"], ["t", "span"], ["r", "refresh"], ["?", "help"], ["q", "quit"]];
  }
  return [["←/→/1-3", "view"], ["↑↓", "select"], ["Enter", "open"], ["p", "providers"], ["t", "span"], ["r", "refresh"], ["q", "quit"]];
}
