import { describe, expect, test } from "bun:test";

import { codexClaimsFromJwt, jwtClaims } from "./jwt.ts";

function b64url(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

describe("jwtClaims", () => {
  test("decodes an unsigned JWT payload without verifying the signature", () => {
    const header = b64url(JSON.stringify({ alg: "none", typ: "JWT" }));
    const payload = b64url(
      JSON.stringify({
        sub: "user-123",
        email: "user@example.com",
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct-42",
        },
      }),
    );
    const jwt = `${header}.${payload}.sig`;
    const claims = jwtClaims<Record<string, unknown>>(jwt);
    expect(claims.email).toBe("user@example.com");
    expect(claims.sub).toBe("user-123");
    const authClaim = claims["https://api.openai.com/auth"] as { chatgpt_account_id: string };
    expect(authClaim.chatgpt_account_id).toBe("acct-42");
  });

  test("throws on malformed JWTs", () => {
    expect(() => jwtClaims("not-a-jwt")).toThrow();
    expect(() => jwtClaims("only.one")).toThrow();
  });
});

describe("codexClaimsFromJwt", () => {
  test("extracts email and chatgpt_account_id from the nested claim", () => {
    const payload = b64url(
      JSON.stringify({
        email: "alice@example.com",
        "https://api.openai.com/auth": { chatgpt_account_id: "acct-abc" },
      }),
    );
    const jwt = `h.${payload}.s`;
    const out = codexClaimsFromJwt(jwt);
    expect(out.email).toBe("alice@example.com");
    expect(out.account_id).toBe("acct-abc");
  });

  test("returns undefined account_id when the nested claim is absent", () => {
    const payload = b64url(JSON.stringify({ email: "bob@example.com" }));
    const jwt = `h.${payload}.s`;
    const out = codexClaimsFromJwt(jwt);
    expect(out.email).toBe("bob@example.com");
    expect(out.account_id).toBeUndefined();
  });

  test("returns undefined account_id when chatgpt_account_id is empty", () => {
    const payload = b64url(
      JSON.stringify({
        email: "carol@example.com",
        "https://api.openai.com/auth": { chatgpt_account_id: "" },
      }),
    );
    const jwt = `h.${payload}.s`;
    expect(codexClaimsFromJwt(jwt).account_id).toBeUndefined();
  });
});