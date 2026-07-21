import React from "react";
import { Box, Text } from "ink";
import type { LoginModalState } from "../loginModal.ts";
import type { AccountRow } from "../state.ts";
import { buildDetailRows, buildProviderRows, methodLabel } from "../login/providerList.ts";
import { colorFor } from "../theme.ts";
import { truncate } from "../../report/format.ts";

const MAX_VISIBLE = 10;
const LABEL_WIDTH = 24;

/** Start index of a scroll window of `MAX_VISIBLE` rows that keeps `selection`
 *  visible: clamps so the window never runs past either end of `total`. */
function windowStart(selection: number, total: number): number {
  if (total <= MAX_VISIBLE) return 0;
  const half = Math.floor(MAX_VISIBLE / 2);
  return Math.min(Math.max(selection - half, 0), total - MAX_VISIBLE);
}

function accountSummary(row: { accounts: AccountRow[] }): string {
  if (row.accounts.length === 0) return "not connected";
  const noun = row.accounts.length === 1 ? "account" : "accounts";
  return `${row.accounts.length} ${noun} · ${row.accounts.map((a) => a.label).join(", ")}`;
}

function ListView({ login, accounts }: { login: Extract<LoginModalState, { view: "list" }>; accounts: AccountRow[] }): React.JSX.Element {
  const rows = buildProviderRows(accounts, login.filter);
  const start = windowStart(login.selection, rows.length);
  const visible = rows.slice(start, start + MAX_VISIBLE);
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">Providers</Text>
      <Text dimColor={login.filter.length === 0}>
        {login.filter.length === 0 ? "filter: (type to filter)" : `filter: ${login.filter}▌`}
      </Text>
      {rows.length === 0 ? (
        <Text dimColor>no providers match</Text>
      ) : (
        visible.map((row, vi) => {
          const i = start + vi;
          const selected = i === login.selection;
          return (
            <Box key={row.id}>
              <Text color={colorFor(row.id)} bold={selected}>
                {`${selected ? "› " : "  "}${truncate(row.label, LABEL_WIDTH).padEnd(LABEL_WIDTH + 1)}`}
              </Text>
              <Text dimColor>{accountSummary(row)}</Text>
            </Box>
          );
        })
      )}
      <Box marginTop={1}>
        <Text dimColor>↑↓ move · type to filter · Enter manage · Esc close</Text>
      </Box>
    </Box>
  );
}

function DetailView({ login, accounts }: { login: Extract<LoginModalState, { view: "detail" }>; accounts: AccountRow[] }): React.JSX.Element {
  const rows = buildDetailRows(login.providerId, accounts);
  const start = windowStart(login.selection, rows.length);
  const visible = rows.slice(start, start + MAX_VISIBLE);
  return (
    <Box flexDirection="column">
      <Text bold color={colorFor(login.providerId)}>{login.providerId}</Text>
      {visible.map((row, vi) => {
        const i = start + vi;
        const selected = i === login.selection;
        const marker = selected ? "› " : "  ";
        if (row.kind === "account") {
          const a = row.account;
          return (
            <Text key={`a-${i}`} color={a.error ? "red" : undefined} bold={selected}>
              {`${marker}${a.label} · ${a.kind} · ${a.error ?? a.expiry}`}
            </Text>
          );
        }
        return (
          <Text key={`m-${i}`} color="green" bold={selected}>
            {`${marker}+ ${methodLabel(row.method)}`}
          </Text>
        );
      })}
      <Box marginTop={1}>
        <Text dimColor>↑↓ move · Enter select · d remove account · Esc back</Text>
      </Box>
    </Box>
  );
}

function ApikeyView({ login }: { login: Extract<LoginModalState, { view: "apikey" }> }): React.JSX.Element {
  const title = `${login.providerId} · add ${login.method === "adminKey" ? "admin API key" : "API key"}`;
  return (
    <Box flexDirection="column">
      <Text bold color={colorFor(login.providerId)}>{title}</Text>
      {login.busy ? (
        <Text dimColor>validating…</Text>
      ) : (
        <Box flexDirection="column">
          <Text bold={login.field === "key"}>{`API key: ${login.key}${login.field === "key" ? "▌" : ""}`}</Text>
          {login.method === "apiKey" ? (
            <Text bold={login.field === "account"} dimColor={login.field !== "account"}>
              {`Account label (optional): ${login.account}${login.field === "account" ? "▌" : ""}`}
            </Text>
          ) : null}
          {login.error ? <Text color="red">{login.error}</Text> : null}
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>
          {login.busy
            ? "please wait…"
            : `Enter ${login.field === "key" && login.method === "apiKey" ? "next" : "submit"} · Esc back`}
        </Text>
      </Box>
    </Box>
  );
}

function OauthView({ login }: { login: Extract<LoginModalState, { view: "oauth" }> }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text bold color={colorFor(login.providerId)}>{`${login.providerId} · authorize`}</Text>
      {login.url ? <Text>{`URL: ${truncate(login.url, 80)}`}</Text> : null}
      {login.userCode ? <Text bold>{`Code: ${login.userCode}`}</Text> : null}
      <Box marginTop={1}>
        {login.error ? (
          <Text color="red">{login.error}</Text>
        ) : login.inputMode === "paste" ? (
          <Text>{`Paste code/URL: ${login.input}▌`}</Text>
        ) : login.inputMode === "text" ? (
          <Text dimColor>{`${login.inputLabel ?? ""} ${login.input}▌`}</Text>
        ) : (
          <Text dimColor>waiting — complete the login in your browser…</Text>
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{login.error ? "Esc back" : "Enter submit · Esc cancel"}</Text>
      </Box>
    </Box>
  );
}

/** The provider-login overlay: a filterable provider list and a per-provider
 *  detail view (accounts + add-actions). Pure render; input + side effects are
 *  handled by `useProviderLogin`. */
export function ProvidersView({
  login,
  accounts,
}: {
  login: Exclude<LoginModalState, null>;
  accounts: AccountRow[];
}): React.JSX.Element {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      {login.view === "list" ? (
        <ListView login={login} accounts={accounts} />
      ) : login.view === "detail" ? (
        <DetailView login={login} accounts={accounts} />
      ) : login.view === "oauth" ? (
        <OauthView login={login} />
      ) : (
        <ApikeyView login={login} />
      )}
    </Box>
  );
}
