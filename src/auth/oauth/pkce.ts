/**
 * PKCE (RFC 7636) primitives + CSRF state + pasted-callback URL parser.
 * Port of `auth/oauth/mod.rs`.
 */
import { createHash, randomBytes } from "node:crypto";

export interface Pkce {
  /** Base64url-encoded verifier (no padding). */
  verifier: string;
  /** S256 challenge derived from the verifier. */
  challenge: string;
}

/** 96 random bytes -> base64url verifier; S256 challenge via node:crypto. */
export function pkce(): Pkce {
  const verifierBytes = randomBytes(96);
  const verifier = verifierBytes
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const challenge = createHash("sha256")
    .update(verifier)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return { verifier, challenge };
}

/** 16-byte CSRF state, lowercase hex. */
export function randomState(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Parse a pasted redirect URL / query string / raw `code#state` into
 * (code, state). Mirrors oh-my-pi's `parseCallbackInput`.
 */
export function parseCallbackInput(input: string): {
  code?: string;
  state?: string;
} {
  const value = input.trim();
  if (!value) return {};
  const qIdx = value.indexOf("?");
  if (qIdx >= 0) {
    const after = value.slice(qIdx + 1);
    const beforeHash = after.split("#")[0] ?? after;
    const params = parseQuery(beforeHash);
    if (params.has("code")) {
      return { code: params.get("code"), state: params.get("state") };
    }
  }
  if (value.includes("code=")) {
    const trimmed = value.replace(/^[?#]+/, "");
    const params = parseQuery(trimmed);
    return { code: params.get("code"), state: params.get("state") };
  }
  const parts = value.split(/#(.+)/);
  const code = parts[0];
  const state = parts[1];
  return {
    ...(code ? { code } : {}),
    ...(state ? { state } : {}),
  };
}

/** Parse `a=b&c=d` (percent-decoded). Last duplicate wins. */
export function parseQuery(q: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const pair of q.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const k = eq < 0 ? pair : pair.slice(0, eq);
    const v = eq < 0 ? "" : pair.slice(eq + 1);
    out.set(percentDecode(k), percentDecode(v));
  }
  return out;
}

/** `%XX` -> byte; `+` -> space. */
export function percentDecode(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "+") {
      out += " ";
    } else if (ch === "%" && i + 2 < s.length) {
      const hex = s.slice(i + 1, i + 3);
      const code = parseInt(hex, 16);
      if (!Number.isNaN(code)) {
        out += String.fromCharCode(code);
        i += 2;
      } else {
        out += ch;
      }
    } else {
      out += ch;
    }
  }
  return out;
}

/** Percent-encode (RFC 3986 unreserved + space -> %20). */
export function percentEncode(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      ch === "-" ||
      ch === "_" ||
      ch === "." ||
      ch === "~"
    ) {
      out += ch;
    } else if (ch === " ") {
      out += "%20";
    } else {
      const bytes = new TextEncoder().encode(ch);
      for (const b of bytes) out += `%${b.toString(16).toUpperCase()}`;
    }
  }
  return out;
}