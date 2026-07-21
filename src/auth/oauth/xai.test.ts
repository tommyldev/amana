import { describe, expect, test } from "bun:test";

import { tokenToCred, validateXAIEndpoint } from "./xai.ts";

const SKEW_MS = 5 * 60 * 1000;

describe("validateXAIEndpoint", () => {
  test("accepts https on x.ai and *.x.ai", () => {
    expect(validateXAIEndpoint("https://x.ai", "token_endpoint")).toBe("https://x.ai");
    expect(validateXAIEndpoint("https://tokens.x.ai/oauth/token", "token_endpoint")).toBe(
      "https://tokens.x.ai/oauth/token",
    );
  });

  test("rejects non-https schemes", () => {
    expect(() => validateXAIEndpoint("http://x.ai", "token_endpoint")).toThrow();
    expect(() => validateXAIEndpoint("ftp://x.ai", "token_endpoint")).toThrow();
  });

  test("rejects foreign hosts and look-alikes", () => {
    expect(() => validateXAIEndpoint("https://evil.com", "token_endpoint")).toThrow();
    expect(() => validateXAIEndpoint("https://x.ai.evil.com", "token_endpoint")).toThrow();
    expect(() => validateXAIEndpoint("https://evil.x.ai.com", "token_endpoint")).toThrow();
  });
});

describe("xai tokenToCred", () => {
  test("maps fields and applies 5-minute skew", () => {
    const before = Date.now();
    const cred = tokenToCred({ access_token: "a", refresh_token: "r", expires_in: 3600 });
    const after = Date.now();
    expect(cred.type).toBe("oauth");
    expect(cred.access).toBe("a");
    expect(cred.refresh).toBe("r");
    expect(cred.expires).toBeGreaterThanOrEqual(before + 3600 * 1000 - SKEW_MS);
    expect(cred.expires).toBeLessThanOrEqual(after + 3600 * 1000 - SKEW_MS);
    expect(cred.enterprise_url).toBeUndefined();
  });

  test("preserves prev refresh + identity when response omits refresh_token", () => {
    const prev = {
      type: "oauth" as const,
      access: "old",
      refresh: "prev-refresh",
      expires: 1,
      account_id: "grok-acct",
      email: "u@x.ai",
    };
    const cred = tokenToCred({ access_token: "new", expires_in: 3600 }, prev);
    expect(cred.refresh).toBe("prev-refresh");
    expect(cred.account_id).toBe("grok-acct");
    expect(cred.email).toBe("u@x.ai");
  });

  test("throws on missing access_token", () => {
    expect(() => tokenToCred({ access_token: "", expires_in: 3600 })).toThrow(/access_token/);
  });

  test("throws on missing or non-finite expires_in", () => {
    expect(() => tokenToCred({ access_token: "a", refresh_token: "r" })).toThrow(/expires_in/);
    expect(() => tokenToCred({ access_token: "a", refresh_token: "r", expires_in: Number.NaN })).toThrow(/expires_in/);
  });
});
