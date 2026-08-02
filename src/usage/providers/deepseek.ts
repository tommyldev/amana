/**
 * DeepSeek usage fetcher — API key.
 * DeepSeek is a prepaid-balance provider (no rolling quota), so live "usage"
 * is the account's remaining balance:
 *   GET https://api.deepseek.com/user/balance
 *   Headers `Authorization: Bearer <key>`, `Accept: application/json`
 * Response:
 *   { is_available, balance_infos: [{ currency, total_balance,
 *     granted_balance, topped_up_balance }] }
 * All money fields are strings. We emit one limit per currency; the gauge
 * tracks funds remaining (exhausted once the account can no longer make
 * calls, i.e. `is_available === false`).
 */
import type { Database } from "bun:sqlite";
import { sendRetry } from "../http.ts";
import {
  statusOf,
  type UsageAmount,
  type UsageLimit,
  type UsageReport,
  type UsageScope,
  type UsageUnit,
  type UsageWindow,
} from "../types.ts";
import type { Credential } from "../../auth/types.ts";
import type { UsageFetcher } from "../fetcher.ts";

const ENDPOINT = "https://api.deepseek.com/user/balance";

interface BalanceInfo {
  currency?: string;
  total_balance?: string;
  granted_balance?: string;
  topped_up_balance?: string;
}

interface BalancePayload {
  is_available?: boolean;
  balance_infos?: BalanceInfo[];
}

/** DeepSeek returns money as strings; parse leniently, undefined on garbage. */
function money(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}

function buildLimit(info: BalanceInfo, available: boolean): UsageLimit {
  const currency = (info.currency ?? "USD").toUpperCase();
  const total = money(info.total_balance) ?? 0;
  const granted = money(info.granted_balance);
  const toppedUp = money(info.topped_up_balance);
  // No spend history is exposed, so the gauge encodes availability: full while
  // the account can still make calls, empty once DeepSeek reports unavailable.
  const usedFraction = available ? 0 : 1;
  const amount: UsageAmount = {
    used: available ? 0 : total,
    limit: total,
    remaining: available ? total : 0,
    usedFraction,
    remainingFraction: available ? 1 : 0,
    unit: "usd" satisfies UsageUnit,
  };
  const window: UsageWindow = { id: "balance", label: "Balance" };
  const scope: UsageScope = {
    provider: "deepseek",
    accountId: undefined,
    projectId: undefined,
    orgId: undefined,
    modelId: undefined,
    tier: undefined,
    windowId: "balance",
    shared: false,
  };
  const notes: string[] = [];
  if (granted !== undefined) notes.push(`granted ${granted.toFixed(2)} ${currency}`);
  if (toppedUp !== undefined) notes.push(`topped-up ${toppedUp.toFixed(2)} ${currency}`);
  return {
    id: `deepseek:balance:${currency.toLowerCase()}`,
    label: `Balance (${currency})`,
    tier: undefined,
    scope,
    window,
    amount,
    status: statusOf(usedFraction),
    notes,
  };
}

export const deepseekFetcher: UsageFetcher = {
  provider: "deepseek",
  async fetch(cred: Credential, _db: Database): Promise<UsageReport | null> {
    if (cred.type !== "api_key") return null;
    const resp = await sendRetry(ENDPOINT, {
      headers: {
        authorization: `Bearer ${cred.key}`,
        accept: "application/json",
      },
    });
    if (!resp.ok) throw new Error(`deepseek usage HTTP ${resp.status}`);
    const payload = (await resp.json()) as BalancePayload;
    const infos = payload.balance_infos ?? [];
    if (infos.length === 0) return null;
    const available = payload.is_available !== false;
    const limits = infos.map((info) => buildLimit(info, available));
    return {
      provider: "deepseek",
      account: cred.account ?? "api key",
      fetchedAt: Date.now(),
      limits,
      notes: available ? [] : ["Balance unavailable for API calls."],
    };
  },
};
