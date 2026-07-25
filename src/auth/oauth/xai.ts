/**
 * xAI Grok OAuth. OIDC discovery (RFC 8414) resolves the token endpoint, then
 * an RFC 8628 device-code grant: request a device code, open xAI's verification
 * page, poll the discovered token endpoint until the user approves. Refresh
 * re-runs discovery and re-validates the endpoint before sending the stored
 * refresh token. Endpoint validation pins every request to `x.ai` / `*.x.ai`.
 *
 * Port of `oh-my-pi/packages/ai/src/registry/oauth/xai-oauth.ts`.
 */
import type { Credential } from "../types.ts";
import { cliUi, type LoginUi } from "./ui.ts";
import { OAuthHttpError } from "./http.ts";

type OAuthCred = Extract<Credential, { type: "oauth" }>;

const ISSUER = "https://auth.x.ai";
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const DEVICE_CODE_URL = `${ISSUER}/oauth2/device/code`;
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const SCOPE = "openid profile email offline_access grok-cli:access api:access";
const SKEW_MS = 5 * 60 * 1000;
const USERINFO_URL = `${ISSUER}/oauth2/userinfo`;
const USERINFO_TIMEOUT_MS = 15_000;
const XAI_CLI_BILLING_BASE_URL = "https://cli-chat-proxy.grok.com";
const XAI_CLI_BILLING_PATH = "/v1/billing";
const XAI_CLI_BILLING_FORMAT = "credits";

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

/** Reject any URL that is not https:// on x.ai or a subdomain of x.ai. */
export function validateXAIEndpoint(url: string, field: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid xAI ${field}: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Invalid xAI ${field}: ${url}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (!host || (host !== "x.ai" && !host.endsWith(".x.ai"))) {
    throw new Error(`Invalid xAI ${field}: ${url}`);
  }
  return url;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reject any billing URL that is not https on grok.com or a subdomain. */
export function validateXAIBillingEndpoint(url: string, field = "billing_url"): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid xAI ${field}: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Invalid xAI ${field}: ${url}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (!host || (host !== "grok.com" && !host.endsWith(".grok.com"))) {
    throw new Error(`Invalid xAI ${field}: ${url}`);
  }
  return url;
}

/** Decode an xAI access-token JWT payload without verifying its signature. */
export function parseXaiAccessTokenPayload(jwt: string): Record<string, unknown> | null {
  try {
    if (typeof jwt !== "string" || !jwt.includes(".")) return null;
    const parts = jwt.split(".");
    if (parts.length < 2 || !parts[1]) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    return isRecord(payload) ? payload : null;
  } catch {
    return null;
  }
}

/** Extract the stable xAI subject UUID from an access token. */
export function extractXaiAccessTokenSubject(jwt: string): string | undefined {
  const sub = parseXaiAccessTokenPayload(jwt)?.sub;
  return typeof sub === "string" && sub.trim() ? sub.trim() : undefined;
}

export interface XaiOAuthIdentity {
  accountId?: string;
  email?: string;
  name?: string;
}

/** Fetch optional OIDC userinfo for a valid xAI access token. Best effort. */
export async function fetchXaiOAuthIdentity(accessToken: string): Promise<XaiOAuthIdentity | null> {
  const token = accessToken.trim();
  if (!token) return null;
  try {
    const resp = await fetch(USERINFO_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(USERINFO_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const payload = (await resp.json()) as unknown;
    if (!isRecord(payload)) return null;
    const sub = typeof payload.sub === "string" && payload.sub.trim() ? payload.sub.trim() : undefined;
    const email = typeof payload.email === "string" && payload.email.trim() ? payload.email.trim() : undefined;
    const name = typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : undefined;
    if (!sub && !email && !name) return null;
    return {
      ...(sub ? { accountId: sub } : {}),
      ...(email ? { email: email.toLowerCase() } : {}),
      ...(name ? { name } : {}),
    };
  } catch {
    return null;
  }
}

async function enrichIdentity(cred: OAuthCred): Promise<OAuthCred> {
  const identity = await fetchXaiOAuthIdentity(cred.access);
  const accountId = cred.account_id ?? identity?.accountId ?? extractXaiAccessTokenSubject(cred.access);
  const email = cred.email ?? identity?.email;
  return { ...cred, ...(accountId ? { account_id: accountId } : {}), ...(email ? { email } : {}) };
}

/** Build the SuperGrok CLI billing URL. Pass `""` to omit `format`. */
export function buildXaiCliBillingUrl(format: string = XAI_CLI_BILLING_FORMAT): string {
  const url = new URL(XAI_CLI_BILLING_PATH, XAI_CLI_BILLING_BASE_URL);
  if (format) url.searchParams.set("format", format);
  return validateXAIBillingEndpoint(url.toString());
}

/** Headers for SuperGrok CLI billing (`cli-chat-proxy.grok.com`). */
export function getXaiCliBillingHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "X-XAI-Token-Auth": "xai-grok-cli",
  };
}

/** Fetch the OIDC discovery document and return the validated token endpoint. */
async function discoverTokenEndpoint(): Promise<string> {
  const resp = await fetch(DISCOVERY_URL, { method: "GET", headers: { Accept: "application/json" } });
  const text = await resp.text();
  if (!resp.ok) throw new OAuthHttpError(resp.status, DISCOVERY_URL, text);
  const payload = JSON.parse(text) as { token_endpoint?: unknown };
  const endpoint = typeof payload.token_endpoint === "string" ? payload.token_endpoint.trim() : "";
  if (!endpoint) throw new Error("xAI OIDC discovery response missing token_endpoint");
  return validateXAIEndpoint(endpoint, "token_endpoint");
}

async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const resp = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPE }),
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
    throw new Error("xAI device-code response missing or invalid required fields");
  }
  validateXAIEndpoint(verification_uri, "verification_uri");
  validateXAIEndpoint(verification_uri_complete, "verification_uri_complete");
  return { device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval };
}

export async function login(_provider?: string, ui: LoginUi = cliUi()): Promise<OAuthCred> {
  const tokenEndpoint = await discoverTokenEndpoint();
  const device = await requestDeviceCode();
  ui.prompt({ url: device.verification_uri_complete, userCode: device.user_code });

  const intervalMs = device.interval * 1000;
  const expiresAtMs = Date.now() + device.expires_in * 1000;

  while (Date.now() < expiresAtMs) {
    await sleep(intervalMs);
    const resp = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
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
    const code = payload.error;
    if (code === "authorization_pending") continue;
    if (code === "slow_down") {
      await sleep(5000);
      continue;
    }
    if (code === "expired_token") throw new Error("xAI device flow expired; restart amana login");
    if (code === "access_denied") throw new Error("xAI device flow denied by user");
    throw new OAuthHttpError(resp.status, tokenEndpoint, text);
  }
  throw new Error("xAI device flow timed out before authorization");
}

export async function refresh(cred: Credential): Promise<OAuthCred> {
  if (cred.type !== "oauth" || !cred.refresh) {
    throw new Error("xai-oauth refresh: missing refresh token");
  }
  const tokenEndpoint = await discoverTokenEndpoint();
  const resp = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: cred.refresh,
    }),
  });
  const text = await resp.text();
  if (!resp.ok) throw new OAuthHttpError(resp.status, tokenEndpoint, text);
  return tokenToCred(JSON.parse(text) as TokenResponse, cred);
}

/** Pure token→credential mapping; exported for unit testing. */
export function tokenToCred(t: TokenResponse, prev?: OAuthCred): OAuthCred {
  if (!t.access_token) throw new Error("xAI token response missing access_token");
  if (typeof t.expires_in !== "number" || !Number.isFinite(t.expires_in)) {
    throw new Error("xAI token response missing expires_in");
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
