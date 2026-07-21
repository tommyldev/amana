import React from "react";
import { Box, Text } from "ink";

export interface HelpOverlayProps {
  visible: boolean;
}

const ROWS: [string, string][] = [
  ["1", "Limits"],
  ["2", "Overview"],
  ["3", "Settings"],
  ["Tab", "cycle view"],
  ["←/→", "switch view"],
  ["↑↓/jk", "select / move"],
  ["Enter", "open provider"],
  ["Esc", "back"],
  ["Space", "toggle setting"],
  ["t", "cycle chart span"],
  ["r", "force refresh"],
  ["x", "dismiss banner"],
  ["p", "providers / login"],
  ["?/h", "toggle help"],
  ["q / ^C", "quit"],
];

export function HelpOverlay({ visible }: HelpOverlayProps): React.JSX.Element | null {
  if (!visible) return null;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
    >
      <Text bold>Keys</Text>
      {ROWS.map(([k, d]) => (
        <Text key={k}>{`${k.padEnd(10)} ${d}`}</Text>
      ))}
    </Box>
  );
}
