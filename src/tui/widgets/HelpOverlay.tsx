import React from "react";
import { Box, Text } from "ink";

export interface HelpOverlayProps {
  visible: boolean;
}

const ROWS: [string, string][] = [
  ["1/2/3", "jump tab"],
  ["Tab", "cycle tab"],
  ["↑↓/jk", "select"],
  ["Enter/→/l", "drill in"],
  ["Esc/←/BS", "back"],
  ["r", "force refresh"],
  ["t", "cycle span (tokens)"],
  ["x", "dismiss banner"],
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
