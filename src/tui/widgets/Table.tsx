import React from "react";
import { Box, Text } from "ink";

export interface TableColumn {
  header: string;
  width: number;
  align?: "left" | "right";
}

export interface TableProps {
  columns: TableColumn[];
  rows: string[][];
  selected?: number;
}

function padCell(text: string, width: number, align: "left" | "right" | undefined): string {
  const truncated = text.length > width ? text.slice(0, width) : text;
  const spaces = Math.max(0, width - truncated.length);
  if (align === "right") return " ".repeat(spaces) + truncated;
  return truncated + " ".repeat(spaces);
}

export function Table({ columns, rows, selected }: TableProps): React.JSX.Element {
  const headerCells = columns.map((c) => padCell(c.header, c.width, c.align)).join(" ");
  return (
    <Box flexDirection="column">
      <Text bold>{headerCells}</Text>
      {rows.map((row, idx) => {
        const cells = columns
          .map((c, i) => padCell(row[i] ?? "", c.width, c.align))
          .join(" ");
        const isSelected = selected === idx;
        return (
          <Text key={idx} inverse={isSelected}>
            {isSelected ? `> ${cells}` : `  ${cells}`}
          </Text>
        );
      })}
    </Box>
  );
}
