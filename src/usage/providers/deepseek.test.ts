/**
 * Tests for the DeepSeek balance fetcher. Verifies the balance envelope maps
 * to one usd limit per currency, availability drives status, and non-api-key
 * credentials/empty payloads are ignored.
 */
import { describe, expect, test } from "bun:test";
import { deepseekFetcher } from "./deepseek.ts";
import type { Credential } from "../../auth/types.ts";
import type { Database } from "bun:sqlite";

const API_KEY: Credential = { type: "api_key", key: "sk-test", account: "me" };
type FetchImpl = typeof globalThis.fetch;

function stubReturning(body: unknown, captured: Request[], status = 200): FetchImpl {
  return async (input, init) => {
    captured.push(new Request(typeof input === "string" ? input : input.toString(), init));
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
}

describe("deepseekFetcher", () => {
  test("maps an available balance to an ok usd limit and Bearer auth", async () => {
    const reqs: Request[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = stubReturning(
      {
        is_available: true,
        balance_infos: [
          { currency: "USD", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" },
        ],
      },
      reqs,
    );
    try {
      const report = await deepseekFetcher.fetch(API_KEY, {} as Database);
      expect(reqs[0]?.url).toBe("https://api.deepseek.com/user/balance");
      expect(reqs[0]?.headers.get("authorization")).toBe("Bearer sk-test");
      expect(report?.limits).toHaveLength(1);
      const limit = report?.limits?.[0];
      expect(limit?.amount.remaining).toBe(110);
      expect(limit?.amount.limit).toBe(110);
      expect(limit?.amount.usedFraction).toBe(0);
      expect(limit?.amount.unit).toBe("usd");
      expect(limit?.status).toBe("ok");
      expect(limit?.notes).toContain("granted 10.00 USD");
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("is_available false marks the balance exhausted", async () => {
    const reqs: Request[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = stubReturning(
      { is_available: false, balance_infos: [{ currency: "CNY", total_balance: "0.00" }] },
      reqs,
    );
    try {
      const report = await deepseekFetcher.fetch(API_KEY, {} as Database);
      const limit = report?.limits?.[0];
      expect(limit?.label).toBe("Balance (CNY)");
      expect(limit?.amount.usedFraction).toBe(1);
      expect(limit?.status).toBe("exhausted");
      expect(report?.notes).toContain("Balance unavailable for API calls.");
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("returns null for empty balances and non-api-key credentials", async () => {
    const reqs: Request[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = stubReturning({ is_available: true, balance_infos: [] }, reqs);
    try {
      expect(await deepseekFetcher.fetch(API_KEY, {} as Database)).toBeNull();
      const oauth: Credential = { type: "oauth", access: "tok" };
      expect(await deepseekFetcher.fetch(oauth, {} as Database)).toBeNull();
    } finally {
      globalThis.fetch = orig;
    }
  });
});
