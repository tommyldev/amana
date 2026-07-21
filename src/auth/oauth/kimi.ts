/**
 * Kimi Code OAuth. RFC 8628 device-code grant against auth.kimi.com: request a
 * device code, open the verification page, and poll the token endpoint until
 * the user approves. Refresh hits the same endpoint with grant_type=refresh_token.
 *
 * Kimi requires `X-Msh-*` device headers on both endpoints; a fresh device id is
 * generated per login (no on-disk persistence, unlike the upstream reference).
 *
 * `enterprise_url` is intentionally NOT set on the credential: the kimi usage
 * fetcher reads it as the API base URL (defaulting to api.kimi.com), and writing
 * the OAuth host there would corrupt the post-login health check. The OAuth host
 * for refresh is the module-level constant below.
 *
 * Port of `oh-my-pi/packages/ai/src/registry/oauth/kimi.ts`.
 */
import * as crypto from "node:crypto";
import * as os from "node:os";
import type { Credential } from "../types.ts";
import { cliUi, type LoginUi } from "./ui.ts";
import { OAuthHttpError } from "./http.ts";

type OAuthCred = Extract<Credential, { type: "oauth" }>;

const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const HOST = "https://auth.kimi.com";
const SKEW_MS = 5 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_EXPIRES_MS = 15 * 60 * 1000;

interface DeviceCodeResponse {
  user_code?: string;
  device_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/** Strip non-printable chars and trim; X-Msh header values must be ASCII-safe. */
function sanitize(value: string, fallback = ""): string {
  const clean = value.replace(/[^\x20-\x7E]/g, "").trim();
  return clean || fallback;
}

function deviceModel(): string {
  const platform = os.platform();
  const release = os.release();
  const arch = os.arch();
  const label =
    platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : platform === "linux" ? "Linux" : platform;
  return sanitize([label, release, arch].filter(Boolean).join(" "), "unknown");
}

/** X-Msh-* headers required by Kimi on device_authorization + token requests. */
function kimiHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
    "X-Msh-Platform": "kimi_cli",
    "X-Msh-Version": "1.0.0",
    "X-Msh-Device-Name": sanitize(os.hostname(), "unknown"),
    "X-Msh-Device-Model": deviceModel(),
    "X-Msh-Os-Version": sanitize(os.version(), "unknown"),
    "X-Msh-Device-Id": crypto.randomUUID().replace(/-/g, ""),
  };
}

export async function login(_provider?: string, ui: LoginUi = cliUi()): Promise<OAuthCred> {
  const url = `${HOST}/api/oauth/device_authorization`;
  const resp = await fetch(url, {
    method: "POST",
    headers: kimiHeaders(),
    body: new URLSearchParams({ client_id: CLIENT_ID }),
  });
  const text = await resp.text();
  if (!resp.ok) throw new OAuthHttpError(resp.status, url, text);
  const device = JSON.parse(text) as DeviceCodeResponse;
  const userCode = device.user_code?.trim();
  const deviceCode = device.device_code?.trim();
  const verificationUri = (device.verification_uri_complete ?? device.verification_uri)?.trim();
  if (!userCode || !deviceCode || !verificationUri) {
    throw new Error("kimi device authorization response missing required fields");
  }
  ui.prompt({ url: verificationUri, userCode: userCode });

  const intervalMs =
    typeof device.interval === "number" && device.interval > 0 ? device.interval * 1000 : DEFAULT_INTERVAL_MS;
  const expiresAtMs =
    Date.now() +
    (typeof device.expires_in === "number" && device.expires_in > 0 ? device.expires_in * 1000 : DEFAULT_EXPIRES_MS);

  const tokenUrl = `${HOST}/api/oauth/token`;
  while (Date.now() < expiresAtMs) {
    await sleep(intervalMs);
    const pollResp = await fetch(tokenUrl, {
      method: "POST",
      headers: kimiHeaders(),
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const pollText = await pollResp.text();
    let payload: TokenResponse;
    try {
      payload = JSON.parse(pollText) as TokenResponse;
    } catch {
      payload = {};
    }
    if (pollResp.ok && payload.access_token) {
      return tokenToCred(payload);
    }
    const code = payload.error;
    if (code === "authorization_pending") continue;
    if (code === "slow_down") {
      await sleep(5000);
      continue;
    }
    if (code === "expired_token") throw new Error("kimi device flow expired; restart amana login");
    if (code === "access_denied") throw new Error("kimi device flow denied by user");
    throw new OAuthHttpError(pollResp.status, tokenUrl, pollText);
  }
  throw new Error("kimi device flow timed out before authorization");
}

export async function refresh(cred: Credential): Promise<OAuthCred> {
  if (cred.type !== "oauth" || !cred.refresh) {
    throw new Error("kimi refresh: missing refresh token");
  }
  const url = `${HOST}/api/oauth/token`;
  const resp = await fetch(url, {
    method: "POST",
    headers: kimiHeaders(),
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: cred.refresh,
      client_id: CLIENT_ID,
    }),
  });
  const text = await resp.text();
  if (!resp.ok) throw new OAuthHttpError(resp.status, url, text);
  return tokenToCred(JSON.parse(text) as TokenResponse, cred);
}

/** Pure token→credential mapping; exported for unit testing. */
export function tokenToCred(t: TokenResponse, prev?: OAuthCred): OAuthCred {
  if (!t.access_token) throw new Error("kimi token response missing access_token");
  if (typeof t.expires_in !== "number" || !Number.isFinite(t.expires_in)) {
    throw new Error("kimi token response missing expires_in");
  }
  const refresh = t.refresh_token ?? prev?.refresh;
  if (!refresh) throw new Error("kimi token response missing refresh token");
  return {
    type: "oauth",
    access: t.access_token,
    refresh,
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
