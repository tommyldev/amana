/**
 * OpenAI Codex (ChatGPT) OAuth login + refresh. NEW flow (no Rust equivalent):
 * PKCE authorize via auth.openai.com, code exchange against the form-encoded
 * token endpoint, decode the `id_token` JWT for account metadata.
 *
 * Requires a ChatGPT plan; if `chatgpt_account_id` is missing from the JWT,
 * login fails with a hard error because the usage endpoint needs it.
 */
import type { Credential } from "../types.ts";
import { loopbackCallback } from "./callback.ts";
import { codexClaimsFromJwt } from "./jwt.ts";
import { OAuthHttpError, postForm } from "./http.ts";
import { pkce, randomState } from "./pkce.ts";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPES = "openid profile email offline_access";
const SKEW_MS = 5 * 60 * 1000;

const EXTRA_PARAMS = "id_token_add_organizations=false&codex_cli_simplified_flow=true";

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  id_token?: string;
}

export async function login(_provider?: string): Promise<Credential> {
  const { verifier, challenge } = pkce();
  const state = randomState();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  const baseAuthUrl = `${AUTHORIZE_URL}?${params.toString()}`;
  const { code: rawCode } = await loopbackCallback(CALLBACK_PORT, CALLBACK_PATH, state, baseAuthUrl);
  const code = rawCode.split("#")[0]!;
  const base = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });
  let tokens: TokenResponse;
  try {
    tokens = (await postForm(TOKEN_URL, Object.fromEntries(base))) as TokenResponse;
  } catch (err) {
    if (!(err instanceof OAuthHttpError) || err.status !== 400) throw err;
    const retryBody = `${base.toString()}&${EXTRA_PARAMS}`;
    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: retryBody,
    });
    const text = await resp.text();
    if (!resp.ok) throw new OAuthHttpError(resp.status, TOKEN_URL, text);
    tokens = JSON.parse(text) as TokenResponse;
  }
  return tokenToCred(tokens);
}

export async function refresh(cred: Credential): Promise<Credential> {
  if (cred.type !== "oauth" || !cred.refresh) {
    throw new Error("openai-codex refresh: missing refresh token");
  }
  const tokens = (await postForm(TOKEN_URL, {
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: cred.refresh,
  })) as TokenResponse;
  return tokenToCred(tokens, cred);
}

function tokenToCred(t: TokenResponse, prev?: Extract<Credential, { type: "oauth" }>): Extract<Credential, { type: "oauth" }> {
  const claims = t.id_token ? codexClaimsFromJwt(t.id_token) : {};
  // On refresh the token response usually omits id_token; keep the account_id
  // captured at login instead of hard-failing.
  const account_id = claims.account_id ?? prev?.account_id;
  if (!account_id) {
    throw new Error("this account has no ChatGPT plan");
  }
  return {
    type: "oauth",
    access: t.access_token,
    refresh: t.refresh_token ?? prev?.refresh,
    expires: Date.now() + t.expires_in * 1000 - SKEW_MS,
    account_id,
    email: claims.email ?? prev?.email,
    enterprise_url: prev?.enterprise_url,
  };
}