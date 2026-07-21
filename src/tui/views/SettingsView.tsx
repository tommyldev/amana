import React from "react";
import { Box, Text } from "ink";
import type { TuiState } from "../state.ts";

function Toggle({ on }: { on: boolean }): React.JSX.Element {
  return <Text color={on ? "green" : "gray"}>{on ? "● on" : "○ off"}</Text>;
}

export function SettingsView({ state }: { state: TuiState }): React.JSX.Element {
  const { settings, settingsSel, editing, editBuffer } = state;
  const rows: { label: string; value: React.ReactNode }[] = [
    { label: "Alerts enabled", value: <Toggle on={settings.enabled} /> },
    { label: "Desktop notifications", value: <Toggle on={settings.desktop} /> },
    {
      label: "Alert thresholds (%)",
      value: editing ? (
        <Text color="cyan">{editBuffer}▌</Text>
      ) : (
        <Text>{settings.thresholds.join(", ") || "none"}</Text>
      ),
    },
    { label: "Send test notification", value: <Text dimColor>press Enter</Text> },
  ];

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        alerts
      </Text>
      <Text dimColor>fires when any limit — live quota or a configured cap — crosses a threshold · saved to config.toml</Text>
      <Box flexDirection="column" marginTop={1}>
        {rows.map((row, i) => {
          const selected = i === settingsSel;
          return (
            <Box key={row.label}>
              <Text bold={selected} color={selected ? "cyan" : undefined}>
                {selected ? "› " : "  "}
                {row.label.padEnd(24)}
              </Text>
              {row.value}
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          {editing
            ? "type digits & commas · Enter save · Esc cancel"
            : "↑↓ move · Space toggle · Enter edit/run"}
        </Text>
      </Box>
    </Box>
  );
}
