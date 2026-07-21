import { describe, expect, test } from "bun:test";

import { tokenToCred } from "./kimi.ts";

const SKEW_MS = 5 * 60 * 1000;

describe("kimi tokenToCred", () => {
  test("maps fields and applies 5-minute skew", () => {
    const before = Date.now();
    const cred = tokenToCred({ access_token: "a", refresh_token: "r", expires_in: 3600 });
    const after = Date.now();
    expect(cred.type).toBe("oauth");
    expect(cred.access).toBe("a");
    expect(cred.refresh).toBe("r");
    expect(cred.expires).toBeGreaterThanOrEqual(before + 3600 * 1000 - SKEW_MS);
    expect(cred.expires).toBeLessThanOrEqual(after + 3600 * 1000 - SKEW_MS);
    // enterprise_url MUST stay unset — the usage fetcher reads it as the API base.
    expect(cred.enterprise_url).toBeUndefined();
  });

  test("preserves prev refresh + identity when response omits refresh_token", () => {
    const prev = {
      type: "oauth" as const,
      access: "old",
      refresh: "prev-refresh",
      expires: 1,
      account_id: "acct-1",
      email: "u@kimi.com",
    };
    const cred = tokenToCred({ access_token: "new", expires_in: 3600 }, prev);
    expect(cred.refresh).toBe("prev-refresh");
    expect(cred.account_id).toBe("acct-1");
    expect(cred.email).toBe("u@kimi.com");
    expect(cred.enterprise_url).toBeUndefined();
  });

  test("throws on missing access_token", () => {
    expect(() => tokenToCred({ access_token: "", expires_in: 3600 })).toThrow(/access_token/);
  });

  test("throws on missing or non-finite expires_in", () => {
    expect(() => tokenToCred({ access_token: "a", refresh_token: "r" })).toThrow(/expires_in/);
    expect(() => tokenToCred({ access_token: "a", refresh_token: "r", expires_in: Number.NaN })).toThrow(/expires_in/);
  });

  test("throws when neither response nor prev supplies a refresh token", () => {
    expect(() => tokenToCred({ access_token: "a", expires_in: 3600 })).toThrow(/refresh/);
  });
});
