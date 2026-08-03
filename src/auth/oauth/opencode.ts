/**
 * OpenCode Go OAuth (RFC 8628 device flow) against console.opencode.ai.
 *
 * The console's Go subscription meters live behind the user's OpenCode
 * account, and the `sk-...` API key does NOT authenticate the console API —
 * so real quota numbers are only reachable through the console's OAuth
 * device flow, using the same public client (`opencode-cli`) the opencode
 * CLI itself uses. This module implements that flow: request a device code,
 * show the verification URL + user code, poll the token endpoint until the
 * user approves, then refresh with the stored refresh token. All requests
 * are JSON (verified against the live console), and the user-facing
 * verification URL is pinned to the console origin.
 */
import type { Credential } from "../types.ts";
import { cliUi, type LoginUi } from "./ui.ts";
import { OAuthHttpError } from "./http.ts";

type OAuthCred = Extract<Credential, { type: "oauth" }>;

/** Console API base URL (also the origin of the device verification page). */
export const OPENCODE_CONSOLE_BASE = "https://console.opencode.ai";
/** Console endpoint returning the account's Go subscription status/meters. */
export const OPENCODE_GO_STATUS_PATH = "/api/go/status";

const DEVICE_CODE_URL = `${OPENCODE_CONSOLE_BASE}/auth/device/code`;
const TOKEN_URL = `${OPENCODE_CONSOLE_BASE}/auth/device/token`;
const USER_URL = `${OPENCODE_CONSOLE_BASE}/api/user`;
const CLIENT_ID = "opencode-cli";
const SKEW_MS = 5 * 60 * 1000;
const IDENTITY_TIMEOUT_MS = 15_000;

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Headers for authenticated console API calls (e.g. the Go status endpoint). */
export function opencodeConsoleHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };
}

/** Absolute verification URL, pinned to the console origin (relative path or https on *.opencode.ai). */
function resolveVerificationUrl(uri: string, field: string): string {
  const value = uri.trim();
  if (!value) throw new Error(`opencode-go device-code response missing ${field}`);
  if (value.startsWith("/")) return `${OPENCODE_CONSOLE_BASE}${value}`;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`opencode-go ${field} is not a valid URL`);
  }
  const host = parsed.hostname;
  if (parsed.protocol !== "https:" || (host !== "console.opencode.ai" && !host.endsWith(".opencode.ai"))) {
    throw new Error(`opencode-go ${field} does not point at the OpenCode console`);
  }
  return parsed.toString();
}

async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const resp = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  });
  const text = await resp.text();
  if (!resp.ok) throw new OAuthHttpError(resp.status, DEVICE_CODE_URL, text);
  const p = JSON.parse(text) as Partial<DeviceCodeResponse>;
  const device_code = typeof p.device_code === "string" ? p.device_code.trim() : "";
  const user_code = typeof p.user_code === "string" ? p.user_code.trim() : "";
  const verification_uri = typeof p.verification_uri === "string" ? p.verification_uri.trim() : "";
  const verification_uri_complete =
    typeof p.verification_uri_complete === "string" ? p.verification_uri_complete.trim() : "";
  const expires_in = p.expires_in;
  const interval = p.interval;
  if (
    !device_code ||
    !user_code ||
    !verification_uri ||
    !verification_uri_complete ||
    typeof expires_in !== "number" ||
    !Number.isFinite(expires_in) ||
    expires_in <= 0 ||
    typeof interval !== "number" ||
    !Number.isFinite(interval) ||
    interval <= 0
  ) {
    throw new Error("opencode-go device-code response missing or invalid required fields");
  }
  return { device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval };
}

/** Best-effort identity lookup (`GET /api/user`); failures never fail the login. */
async function fetchOpencodeUser(accessToken: string): Promise<{ accountId?: string; email?: string }> {
  try {
    const resp = await fetch(USER_URL, {
      method: "GET",
      headers: opencodeConsoleHeaders(accessToken),
      redirect: "error",
      signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
    });
    if (!resp.ok) return {};
    const payload = (await resp.json()) as unknown;
    if (!isRecord(payload)) return {};
    const id = typeof payload.id === "string" && payload.id.trim() ? payload.id.trim() : undefined;
    const email =
      typeof payload.email === "string" && payload.email.trim() ? payload.email.trim().toLowerCase() : undefined;
    return { ...(id ? { accountId: id } : {}), ...(email ? { email } : {}) };
  } catch {
    return {};
  }
}

async function enrichIdentity(cred: OAuthCred): Promise<OAuthCred> {
  const user = await fetchOpencodeUser(cred.access);
  const accountId = cred.account_id ?? user.accountId;
  const email = cred.email ?? user.email;
  return { ...cred, ...(accountId ? { account_id: accountId } : {}), ...(email ? { email } : {}) };
}

export async function login(_provider?: string, ui: LoginUi = cliUi()): Promise<OAuthCred> {
  const device = await requestDeviceCode();
  const verificationUrl = resolveVerificationUrl(device.verification_uri_complete, "verification_uri_complete");
  ui.prompt({ url: verificationUrl, userCode: device.user_code });

  let intervalMs = device.interval * 1000;
  const expiresAtMs = Date.now() + device.expires_in * 1000;

  while (Date.now() < expiresAtMs) {
    await sleep(intervalMs);
    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: CLIENT_ID,
        device_code: device.device_code,
      }),
    });
    const text = await resp.text();
    let payload: TokenResponse;
    try {
      payload = JSON.parse(text) as TokenResponse;
    } catch {
      payload = {};
    }
    if (resp.ok && payload.access_token) {
      return enrichIdentity(tokenToCred(payload));
    }
    // Non-2xx pending/error bodies carry {"_tag":"DeviceTokenError","error":"..."}.
    const code = payload.error;
    if (code === "authorization_pending") continue;
    if (code === "slow_down") {
      intervalMs += 5000;
      continue;
    }
    if (code === "expired_token") throw new Error("opencode-go device flow expired; restart amana login");
    if (code === "access_denied") throw new Error("opencode-go device flow denied by user");
    throw new OAuthHttpError(resp.status, TOKEN_URL, text);
  }
  throw new Error("opencode-go device flow timed out before authorization");
}

export async function refresh(cred: Credential): Promise<OAuthCred> {
  if (cred.type !== "oauth" || !cred.refresh) {
    throw new Error("opencode-go refresh: missing refresh token");
  }
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: cred.refresh }),
  });
  const text = await resp.text();
  if (!resp.ok) throw new OAuthHttpError(resp.status, TOKEN_URL, text);
  return tokenToCred(JSON.parse(text) as TokenResponse, cred);
}

/** Pure token→credential mapping; exported for unit testing. */
export function tokenToCred(t: TokenResponse, prev?: OAuthCred): OAuthCred {
  if (!t.access_token) throw new Error("opencode-go token response missing access_token");
  if (typeof t.expires_in !== "number" || !Number.isFinite(t.expires_in)) {
    throw new Error("opencode-go token response missing expires_in");
  }
  return {
    type: "oauth",
    access: t.access_token,
    refresh: t.refresh_token ?? prev?.refresh,
    expires: Date.now() + t.expires_in * 1000 - SKEW_MS,
    account_id: prev?.account_id,
    email: prev?.email,
  };
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
