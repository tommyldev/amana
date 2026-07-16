/**
 * One credential for a provider account. Serialized as tagged JSON (matching
 * the legacy Rust serde shape) in the plain-file credential store, e.g.
 * `{"type":"oauth","access":"…",...}`.
 */
export type Credential =
  | { type: "api_key"; key: string; account?: string; enterprise_url?: string }
  | {
      type: "oauth";
      access: string;
      refresh?: string;
      /** Epoch ms when the access token expires (skew already subtracted). */
      expires?: number;
      account_id?: string;
      email?: string;
      project_id?: string;
      enterprise_url?: string;
    };

/** Stable identity used to dedupe accounts within a provider. */
export function identity(c: Credential): string | undefined {
  if (c.type === "api_key") return c.account;
  return c.email ?? c.account_id ?? c.project_id;
}

/** Display label for an account row. */
export function accountLabel(c: Credential): string {
  if (c.type === "api_key") return c.account ?? "api key";
  return c.email ?? c.account_id ?? c.project_id ?? "account";
}

/** True when an OAuth access token is past (or within skew of) expiry. */
export function needsRefresh(c: Credential, nowMs: number): boolean {
  return c.type === "oauth" && c.expires != null && nowMs >= c.expires;
}
