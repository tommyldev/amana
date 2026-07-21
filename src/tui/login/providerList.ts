/**
 * Pure derivation for the TUI provider-login manager: the filterable provider
 * list (oh-my-pi style) and each provider's account/action detail rows. Shared
 * by `ProvidersView` (render) and `useProviderLogin` (input → side effect) so
 * both read identical row ordering and indices.
 */
import type { AccountRow } from "../state.ts";
import { isMixed, loginKindFor, loginableIds } from "../../auth/loginFlows.ts";
import { byId } from "../../registry.ts";

export type LoginMethod = "oauth" | "apiKey" | "adminKey";

export interface ProviderRow {
  id: string;
  label: string;
  /** Stored accounts for this provider (empty when not connected). */
  accounts: AccountRow[];
  /** Login methods offered, in display order. */
  methods: LoginMethod[];
}

/** One selectable line in a provider's detail view: an existing account or an
 *  "add via <method>" action. */
export type DetailRow =
  | { kind: "account"; account: AccountRow }
  | { kind: "action"; method: LoginMethod };

/** Login methods a provider offers (oauth-only, api-key-only, admin, or mixed). */
export function methodsFor(id: string): LoginMethod[] {
  switch (loginKindFor(id)) {
    case "AdminKey":
      return ["adminKey"];
    case "ApiKey":
      return ["apiKey"];
    case "OAuth":
      return isMixed(id) ? ["oauth", "apiKey"] : ["oauth"];
    default:
      return [];
  }
}

/** All loginable providers as list rows, filtered by `filter` (matches id or
 *  label, case-insensitive) and sorted connected-first then by label. */
export function buildProviderRows(accounts: AccountRow[], filter: string): ProviderRow[] {
  const q = filter.trim().toLowerCase();
  const rows: ProviderRow[] = [];
  for (const id of loginableIds()) {
    const label = byId(id)?.label ?? id;
    if (q && !id.toLowerCase().includes(q) && !label.toLowerCase().includes(q)) continue;
    rows.push({
      id,
      label,
      accounts: accounts.filter((a) => a.provider === id),
      methods: methodsFor(id),
    });
  }
  return rows.sort(
    (a, b) =>
      (b.accounts.length > 0 ? 1 : 0) - (a.accounts.length > 0 ? 1 : 0) ||
      a.label.localeCompare(b.label),
  );
}

/** A provider's detail rows: one per stored account, then one per add-action. */
export function buildDetailRows(id: string, accounts: AccountRow[]): DetailRow[] {
  const rows: DetailRow[] = accounts
    .filter((a) => a.provider === id)
    .map((account) => ({ kind: "account", account }));
  for (const method of methodsFor(id)) rows.push({ kind: "action", method });
  return rows;
}

/** Human label for an add-action row. */
export function methodLabel(method: LoginMethod): string {
  switch (method) {
    case "oauth":
      return "Add account via OAuth (browser)";
    case "apiKey":
      return "Add account via API key";
    case "adminKey":
      return "Add admin API key";
  }
}
