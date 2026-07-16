/**
 * Anthropic (Claude Pro/Max) OAuth. Port of `auth/oauth/anthropic.rs`: PKCE
 * authorize via claude.ai, code/refresh exchange against the JSON
 * `/v1/oauth/token` endpoint. Keep the previous refresh token when the
 * response omits one.
 */
import type { Credential } from "../types.ts";
import { loopbackCallback } from "./callback.ts";
import { postJsonRaw } from "./http.ts";
import { percentEncode, pkce, randomState } from "./pkce.ts";

type OAuthCred = Extract<Credential, { type: "oauth" }>;

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const CALLBACK_PORT = 54545;
const CALLBACK_PATH = "/callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SKEW_MS = 5 * 60 * 1000;
const SCOPES_ENC = percentEncode("org:create_api_key user:profile user:inference");

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  account?: { uuid?: string; email_address?: string };
}

export async function login(_provider?: string): Promise<OAuthCred> {
  const { verifier, challenge } = pkce();
  const state = randomState();
  const url =
    `${AUTHORIZE_URL}?code=true&client_id=${CLIENT_ID}` +
    `&response_type=code&redirect_uri=${percentEncode(REDIRECT_URI)}` +
    `&scope=${SCOPES_ENC}` +
    `&code_challenge=${challenge}&code_challenge_method=S256&state=${state}`;
  const { code: rawCode, state: returnedState } = await loopbackCallback(
    CALLBACK_PORT,
    CALLBACK_PATH,
    state,
    url,
  );
  const hashSplit = rawCode.split("#");
  const code = hashSplit[0]!;
  const stateFromCode = hashSplit[1];
  const effectiveState = stateFromCode && stateFromCode.length > 0 ? stateFromCode : returnedState;
  const text = await postJsonRaw(TOKEN_URL, {
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code,
    state: effectiveState,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });
  return tokenToCred(JSON.parse(text) as TokenResponse);
}

export async function refresh(cred: Credential): Promise<OAuthCred> {
  if (cred.type !== "oauth" || !cred.refresh) {
    throw new Error("anthropic refresh: missing refresh token");
  }
  const text = await postJsonRaw(TOKEN_URL, {
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: cred.refresh,
  });
  return tokenToCred(JSON.parse(text) as TokenResponse, cred.refresh);
}

function tokenToCred(t: TokenResponse, prevRefresh?: string): OAuthCred {
  const account_id = nonEmpty(t.account?.uuid);
  const email = nonEmpty(t.account?.email_address);
  return {
    type: "oauth",
    access: t.access_token,
    refresh: t.refresh_token ?? prevRefresh,
    expires: Date.now() + t.expires_in * 1000 - SKEW_MS,
    account_id,
    email,
  };
}

function nonEmpty(s: string | undefined): string | undefined {
  return s && s.length > 0 ? s : undefined;
}