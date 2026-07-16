/**
 * Google OAuth (used by google-antigravity and google-gemini-cli). Port of
 * `auth/oauth/google.rs`. Includes a userinfo fetch to recover the email,
 * optional project_id prompt, and refresh that preserves the prior
 * email/project_id/enterprise_url.
 */
import { createInterface } from "node:readline";
import type { Credential } from "../types.ts";
import { loopbackCallback } from "./callback.ts";
import { postJsonRaw } from "./http.ts";
import { percentEncode, pkce, randomState } from "./pkce.ts";

type OAuthCred = Extract<Credential, { type: "oauth" }>;

const CLIENT_ID = "GOOGLE_CLIENT_ID_REDACTED";
const CLIENT_SECRET = "GOOGLE_CLIENT_SECRET_REDACTED";
const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const CALLBACK_PORT = 51121;
const CALLBACK_PATH = "/callback";
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPES =
  "openid email profile " +
  "https://www.googleapis.com/auth/cloud-platform " +
  "https://www.googleapis.com/auth/cclog " +
  "https://www.googleapis.com/auth/experimentsandconfigs";
const SKEW_MS = 60 * 1000;

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

export async function login(provider?: string): Promise<OAuthCred> {
  const { verifier, challenge } = pkce();
  const state = randomState();
  const url =
    `${AUTHORIZE_URL}?client_id=${CLIENT_ID}` +
    `&response_type=code&redirect_uri=${percentEncode(REDIRECT_URI)}` +
    `&scope=${percentEncode(SCOPES)}` +
    `&access_type=offline&prompt=consent` +
    `&code_challenge=${challenge}&code_challenge_method=S256&state=${state}`;
  const { code, state: returnedState } = await loopbackCallback(
    CALLBACK_PORT,
    CALLBACK_PATH,
    state,
    url,
  );
  const text = await postJsonRaw(TOKEN_URL, {
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    state: returnedState,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });
  const cred = tokenToCred(JSON.parse(text) as TokenResponse);
  const email = await fetchEmail(cred.access);
  if (email) cred.email = email;
  if (
    (provider === "google-antigravity" || provider === "google-gemini-cli") &&
    !cred.project_id
  ) {
    const project = await promptProject(
      provider === "google-antigravity"
        ? "Antigravity project id (blank to skip): "
        : "Gemini CLI project id (blank to skip): ",
    );
    const trimmed = project.trim();
    if (trimmed) cred.project_id = trimmed;
  }
  return cred;
}

export async function refresh(cred: Credential): Promise<OAuthCred> {
  if (cred.type !== "oauth" || !cred.refresh) {
    throw new Error("google refresh: missing refresh token");
  }
  const text = await postJsonRaw(TOKEN_URL, {
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: cred.refresh,
  });
  const next = tokenToCred(JSON.parse(text) as TokenResponse, cred.refresh);
  next.email = cred.email ?? next.email;
  next.project_id = cred.project_id;
  next.enterprise_url = cred.enterprise_url;
  if (!next.account_id) next.account_id = cred.email ?? cred.account_id;
  return next;
}

function tokenToCred(t: TokenResponse, prevRefresh?: string): OAuthCred {
  return {
    type: "oauth",
    access: t.access_token,
    refresh: t.refresh_token ?? prevRefresh,
    expires: Date.now() + t.expires_in * 1000 - SKEW_MS,
    account_id: undefined,
    email: undefined,
  };
}

async function fetchEmail(accessToken: string): Promise<string | undefined> {
  const resp = await fetch(USERINFO_URL, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
    },
  });
  if (!resp.ok) return undefined;
  const body = (await resp.json()) as { email?: string };
  return body.email && body.email.length > 0 ? body.email : undefined;
}

function promptProject(message: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  process.stderr.write(message);
  const { promise, resolve } = Promise.withResolvers<string>();
  rl.once("line", (line) => {
    rl.close();
    resolve(line);
  });
  return promise;
}