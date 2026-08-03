import { afterEach, describe, expect, test, vi } from "bun:test";

import type { Credential } from "../types.ts";
import { login, refresh, tokenToCred } from "./opencode.ts";
import { OAuthHttpError } from "./http.ts";
import type { LoginUi } from "./ui.ts";

type OAuthCred = Extract<Credential, { type: "oauth" }>;

const SKEW_MS = 5 * 60 * 1000;
const originalFetch = globalThis.fetch;

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

const DEVICE_CODE_BODY = {
  device_code: "dc-1",
  user_code: "ABCD-EFGH",
  verification_uri: "/device",
  verification_uri_complete: "/device?user_code=ABCD-EFGH&client_id=opencode-cli",
  expires_in: 900,
  interval: 1,
};

const noopUi: LoginUi = {
  prompt: () => {},
  paste: async () => ({ code: "x", state: "s" }),
};

/** Advance fake timers until the login promise settles; bounded so a stuck flow fails instead of hanging. */
async function driveUntilSettled(settled: () => boolean, rounds = 30): Promise<void> {
  for (let i = 0; i < rounds && !settled(); i++) {
    vi.advanceTimersByTime(1000);
    for (let j = 0; j < 50; j++) await Promise.resolve();
  }
  expect(settled()).toBe(true);
}

function runLogin(responses: [number, unknown][]) {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      const [status, body] = responses.shift()!;
      return jsonResponse(status, body);
    },
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  let settled = false;
  let error: unknown;
  let result: OAuthCred | undefined;
  const promise = login(undefined, noopUi).then(
    (cred) => {
      settled = true;
      result = cred;
    },
    (e: unknown) => {
      settled = true;
      error = e;
    },
  );
  return { fetchMock, promise, settled: () => settled, error: () => error, result: () => result };
}

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
});

describe("opencode tokenToCred", () => {
  test("maps fields and applies 5-minute skew to expiry", () => {
    const before = Date.now();
    const cred = tokenToCred({ access_token: "a", refresh_token: "r", expires_in: 3600 });
    const after = Date.now();
    expect(cred.type).toBe("oauth");
    expect(cred.access).toBe("a");
    expect(cred.refresh).toBe("r");
    expect(cred.expires).toBeGreaterThanOrEqual(before + 3600 * 1000 - SKEW_MS);
    expect(cred.expires).toBeLessThanOrEqual(after + 3600 * 1000 - SKEW_MS);
  });

  test("preserves prev refresh + identity when response omits refresh_token", () => {
    const prev = {
      type: "oauth" as const,
      access: "old",
      refresh: "prev-refresh",
      expires: 1,
      account_id: "acct-1",
      email: "u@opencode.ai",
    };
    const cred = tokenToCred({ access_token: "new", expires_in: 3600 }, prev);
    expect(cred.refresh).toBe("prev-refresh");
    expect(cred.account_id).toBe("acct-1");
    expect(cred.email).toBe("u@opencode.ai");
  });

  test("throws on missing access_token", () => {
    expect(() => tokenToCred({ access_token: "", expires_in: 3600 })).toThrow(/access_token/);
  });

  test("throws on missing or non-finite expires_in", () => {
    expect(() => tokenToCred({ access_token: "a", refresh_token: "r" })).toThrow(/expires_in/);
    expect(() => tokenToCred({ access_token: "a", refresh_token: "r", expires_in: Number.NaN })).toThrow(
      /expires_in/,
    );
  });
});

describe("opencode login device flow", () => {
  test("retries on authorization_pending and returns the enriched credential", async () => {
    vi.useFakeTimers();
    const prompted = vi.fn();
    const { fetchMock, settled, error, result } = runLogin([
      [200, DEVICE_CODE_BODY],
      [400, { _tag: "DeviceTokenError", error: "authorization_pending", error_description: "not yet" }],
      [200, { access_token: "tok", refresh_token: "ref", expires_in: 3600 }],
      [200, { id: "user-1", email: "U@opencode.ai" }],
    ]);
    noopUi.prompt = prompted;
    await driveUntilSettled(settled);
    expect(error()).toBeUndefined();
    expect(result()).toBeDefined();
    const cred = result()!;
    expect(cred.access).toBe("tok");
    expect(cred.refresh).toBe("ref");
    expect(cred.account_id).toBe("user-1");
    expect(cred.email).toBe("u@opencode.ai");
    expect(fetchMock).toHaveBeenCalledTimes(4);

    expect(prompted).toHaveBeenCalledWith({
      url: "https://console.opencode.ai/device?user_code=ABCD-EFGH&client_id=opencode-cli",
      userCode: "ABCD-EFGH",
    });

    // Device-code and poll requests are JSON, not form-encoded (verified live).
    const init = fetchMock.mock.calls[0]![1] as unknown as { headers?: Record<string, string>; body?: string };
    expect(init.headers?.["Content-Type"]).toBe("application/json");
    expect(init.body).toContain('"client_id":"opencode-cli"');
    const pollInit = fetchMock.mock.calls[1]![1] as unknown as { headers?: Record<string, string>; body?: string };
    expect(pollInit.body).toContain("urn:ietf:params:oauth:grant-type:device_code");
    expect(pollInit.body).toContain('"device_code":"dc-1"');
  });

  test("surfaces a hard error for an unknown device-token error value", async () => {
    vi.useFakeTimers();
    const { promise, settled, error } = runLogin([
      [200, DEVICE_CODE_BODY],
      [400, { _tag: "DeviceTokenError", error: "invalid_grant", error_description: "nope" }],
    ]);
    await driveUntilSettled(settled);
    await expect(promise).resolves.toBeUndefined();
    expect(error()).toBeInstanceOf(OAuthHttpError);
    expect((error() as Error).message).toContain("invalid_grant");
  });
});

describe("opencode refresh", () => {
  test("rejects a credential with no refresh token", async () => {
    await expect(refresh({ type: "oauth", access: "a", expires: 1 })).rejects.toThrow(/missing refresh token/);
    await expect(refresh({ type: "api_key", key: "k" })).rejects.toThrow(/missing refresh token/);
  });
});
