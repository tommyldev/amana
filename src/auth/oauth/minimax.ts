/**
 * MiniMax (RFC 8628 device-code) OAuth. No loopback: the user authorizes in
 * their browser via a short user_code, atop polls until the token endpoint
 * stops returning `authorization_pending`.
 *
 * Refresh: same host's `/oauth2/token`. The host is recorded on the
 * credential as `enterprise_url` so the refresh call (which has no provider
 * id) can pick the right endpoint.
 */
import type { Credential } from "../types.ts";
import { openBrowser } from "./callback.ts";
import { OAuthHttpError, postJson } from "./http.ts";
import { pkce, randomState } from "./pkce.ts";

const CLIENT_ID = "659cf4c1-615c-45f6-a5f6-4bf15eb476e5";
const SCOPE = "openid profile coding_plan";
const SKEW_MS = 5 * 60 * 1000;
const POLL_TIMEOUT_S = 5 * 60;

const HOSTS: Record<"minimax-code" | "minimax-code-cn", string> = {
  "minimax-code": "https://account.minimax.io",
  "minimax-code-cn": "https://account.minimaxi.com",
};

export async function login(provider?: string): Promise<Credential> {
  const host = provider === "minimax-code-cn" ? HOSTS["minimax-code-cn"] : HOSTS["minimax-code"];
  const { verifier, challenge } = pkce();
  const state = randomState();

  const device = (await postJson(`${host}/oauth2/device/code`, {
    client_id: CLIENT_ID,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  })) as DeviceCodeResponse;

  console.log(`Authorize atop by visiting:\n  ${device.verification_uri}\n`);
  console.log(`Enter code: ${device.user_code}\n`);
  openBrowser(device.verification_uri);

  const interval = (device.interval ?? 5) * 1000;
  const expiresAtMs = Date.now() + device.expires_in * 1000;

  while (Date.now() < expiresAtMs) {
    await sleep(interval);
    try {
      const token = (await postJson(`${host}/oauth2/token`, {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: CLIENT_ID,
        user_code: device.user_code,
        code_verifier: verifier,
      })) as TokenResponse;
      return tokenToCred(token, host);
    } catch (err) {
      if (!(err instanceof OAuthHttpError)) throw err;
      const code = readErrorCode(err.bodyText);
      if (code === "authorization_pending") continue;
      if (code === "slow_down") {
        await sleep(5000);
        continue;
      }
      if (code === "expired_token") throw new Error("device flow expired; restart atop login");
      throw err;
    }
  }
  throw new Error("device flow timed out before authorization");
}

export async function refresh(cred: Credential): Promise<Credential> {
  if (cred.type !== "oauth" || !cred.refresh) {
    throw new Error("minimax refresh: missing refresh token");
  }
  const host = cred.enterprise_url ?? HOSTS["minimax-code"];
  try {
    const token = (await postJson(`${host}/oauth2/token`, {
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: cred.refresh,
    })) as TokenResponse;
    return tokenToCred(token, host, cred);
  } catch (err) {
    if (err instanceof OAuthHttpError && err.status === 400) {
      throw new Error(`re-run: atop login ${hostToProvider(host)}`);
    }
    throw err;
  }
}

interface DeviceCodeResponse {
  user_code: string;
  verification_uri: string;
  interval?: number;
  expires_in: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

function tokenToCred(t: TokenResponse, host: string, prev?: Extract<Credential, { type: "oauth" }>): Extract<Credential, { type: "oauth" }> {
  return {
    type: "oauth",
    access: t.access_token,
    refresh: t.refresh_token ?? prev?.refresh,
    expires: Date.now() + t.expires_in * 1000 - SKEW_MS,
    account_id: prev?.account_id,
    email: prev?.email,
    enterprise_url: host,
  };
}

function hostToProvider(host: string): "minimax-code" | "minimax-code-cn" {
  if (host === HOSTS["minimax-code-cn"]) return "minimax-code-cn";
  return "minimax-code";
}

function readErrorCode(body: string): string | undefined {
  try {
    const obj = JSON.parse(body) as { error?: string };
    return typeof obj.error === "string" ? obj.error : undefined;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}