import React from "react";
import { Box, Text } from "ink";

export interface TabsProps {
  tabs: string[];
  active: number;
}

export function Tabs({ tabs, active }: TabsProps): React.JSX.Element {
  return (
    <Box>
      {tabs.map((tab, i) => {
        const isActive = i === active;
        return (
          <Box key={tab} marginRight={2}>
            <Text bold={isActive} underline={isActive}>
              {tab}
            </Text>
            {i < tabs.length - 1 ? <Text dimColor> │ </Text> : null}
          </Box>
        );
      })}
    </Box>
  );
}
