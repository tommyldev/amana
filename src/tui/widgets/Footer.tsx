import React from "react";
import { Text } from "ink";

export interface FooterProps {
  pairs: [string, string][];
}

export function Footer({ pairs }: FooterProps): React.JSX.Element {
  const text = pairs.map(([key, desc]) => `${key} ${desc}`).join(" · ");
  return <Text dimColor>{text}</Text>;
}
