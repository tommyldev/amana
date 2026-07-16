import React from "react";
import { Box, Text } from "ink";
import type { TuiState } from "../state.ts";
import { Table } from "../widgets/Table.tsx";

export function AccountsView({ state }: { state: TuiState }): React.JSX.Element {
  if (state.accounts.length === 0) {
    return <Text dimColor>no accounts stored — run `atop login &lt;provider&gt;`</Text>;
  }
  const rows = state.accounts.map((a) => [a.provider, a.label, a.kind, a.expiry]);
  return (
    <Box flexDirection="column">
      <Table
        columns={[
          { header: "provider", width: 22 },
          { header: "account", width: 26 },
          { header: "kind", width: 8 },
          { header: "expiry", width: 12 },
        ]}
        rows={rows}
        selected={state.selection}
      />
      {state.accounts.map((a, i) =>
        a.error ? (
          <Text key={`e-${i}`} color="red">
            {a.provider} · {a.label}: {a.error}
          </Text>
        ) : null,
      )}
      <Box marginTop={1}>
        <Text dimColor>remove with: atop accounts remove &lt;provider&gt; [--account &lt;label&gt;]</Text>
      </Box>
    </Box>
  );
}
