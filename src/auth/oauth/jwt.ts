/**
 * Decode the unsigned claims segment of a JWT (no signature verification).
 * Used to extract OpenAI Codex account metadata from the `id_token`.
 */
export interface CodexClaims {
  email?: string;
  account_id?: string;
}

export function jwtClaims<T extends Record<string, unknown> = Record<string, unknown>>(
  jwt: string,
): T {
  const parts = jwt.split(".");
  if (parts.length < 2) throw new Error("malformed JWT: expected at least 2 segments");
  const payload = parts[1];
  const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
  const b64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  const json = Buffer.from(b64, "base64").toString("utf8");
  return JSON.parse(json) as T;
}

/**
 * Extract `email` and `chatgpt_account_id` from a Codex id_token's
 * `https://api.openai.com/auth` claim.
 */
export function codexClaimsFromJwt(jwt: string): CodexClaims {
  const claims = jwtClaims<Record<string, unknown>>(jwt);
  const email = typeof claims.email === "string" ? claims.email : undefined;
  const authClaim = claims["https://api.openai.com/auth"];
  let account_id: string | undefined;
  if (authClaim && typeof authClaim === "object") {
    const id = (authClaim as Record<string, unknown>).chatgpt_account_id;
    if (typeof id === "string" && id.length > 0) account_id = id;
  }
  return { email, account_id };
}