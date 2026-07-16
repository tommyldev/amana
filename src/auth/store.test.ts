import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmodSync, statSync } from "node:fs";

import type { Credential } from "./types.ts";
import { allProviders, load, merge, removeAccount, save, upsert } from "./store.ts";

function dataDir(): string {
  return mkdtempSync(join(tmpdir(), "atop-store-"));
}

function api(key: string, account?: string): Credential {
  return account ? { type: "api_key", key, account } : { type: "api_key", key };
}

function oauth(email: string): Credential {
  return { type: "oauth", access: "a", refresh: "r", expires: 0, email };
}

describe("merge", () => {
  test("collapses identity-less api keys to one (last wins)", () => {
    const creds: Credential[] = [];
    merge(creds, api("k1"));
    merge(creds, api("k2"));
    expect(creds.length).toBe(1);
    if (creds[0]!.type !== "api_key") throw new Error("expected api_key");
    expect(creds[0]!.key).toBe("k2");
  });

  test("keeps distinct emails and replaces duplicates", () => {
    const creds: Credential[] = [];
    merge(creds, oauth("a@x.com"));
    merge(creds, oauth("b@x.com"));
    merge(creds, oauth("a@x.com"));
    expect(creds.length).toBe(2);
    const emails = creds.map((c) => (c.type === "oauth" ? c.email : undefined));
    expect(emails).toContain("a@x.com");
    expect(emails).toContain("b@x.com");
  });

  test("replaces oauth with same account_id", () => {
    const creds: Credential[] = [];
    merge(creds, { type: "oauth", access: "v1", account_id: "acct-1" });
    merge(creds, { type: "oauth", access: "v2", account_id: "acct-1" });
    expect(creds.length).toBe(1);
    if (creds[0]!.type !== "oauth") throw new Error("expected oauth");
    expect(creds[0]!.access).toBe("v2");
  });
});

describe("save/load round-trip", () => {
  test("preserves kind and multi-account", () => {
    const dir = dataDir();
    const creds: Credential[] = [
      oauth("alice@example.com"),
      oauth("bob@example.com"),
      api("sk-test", "team-1"),
    ];
    save(dir, "anthropic", creds);
    const back = load(dir, "anthropic");
    expect(back.length).toBe(3);
    const kinds = back.map((c) => c.type).sort();
    expect(kinds).toEqual(["api_key", "oauth", "oauth"]);
    const emails = back
      .filter((c): c is Extract<Credential, { type: "oauth" }> => c.type === "oauth")
      .map((c) => c.email)
      .sort();
    expect(emails).toEqual(["alice@example.com", "bob@example.com"]);
    const apiKey = back.find((c): c is Extract<Credential, { type: "api_key" }> => c.type === "api_key");
    expect(apiKey?.account).toBe("team-1");
    expect(apiKey?.key).toBe("sk-test");
  });

  test("writes the file with mode 0o600", () => {
    const dir = dataDir();
    save(dir, "zai", [api("k")]);
    const file = join(dir, "credentials.json");
    const mode = statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("save with empty array deletes the provider key", () => {
    const dir = dataDir();
    save(dir, "zai", [api("k")]);
    expect(load(dir, "zai").length).toBe(1);
    save(dir, "zai", []);
    expect(load(dir, "zai").length).toBe(0);
  });

  test("upsert applies merge semantics and persists", () => {
    const dir = dataDir();
    upsert(dir, "anthropic", oauth("a@x.com"));
    upsert(dir, "anthropic", oauth("b@x.com"));
    upsert(dir, "anthropic", oauth("a@x.com"));
    const back = load(dir, "anthropic");
    expect(back.length).toBe(2);
  });
});

describe("removeAccount", () => {
  test("removes the matching identity and returns true", () => {
    const dir = dataDir();
    save(dir, "anthropic", [oauth("a@x.com"), oauth("b@x.com")]);
    expect(removeAccount(dir, "anthropic", "a@x.com")).toBe(true);
    const back = load(dir, "anthropic");
    expect(back.length).toBe(1);
    if (back[0]!.type !== "oauth") throw new Error("expected oauth");
    expect(back[0]!.email).toBe("b@x.com");
  });

  test("returns false when the identity is absent", () => {
    const dir = dataDir();
    save(dir, "anthropic", [oauth("a@x.com")]);
    expect(removeAccount(dir, "anthropic", "nope@x.com")).toBe(false);
  });
});

describe("allProviders", () => {
  test("returns only keys that have >=1 credential and are supported", () => {
    const dir = dataDir();
    save(dir, "anthropic", [oauth("a@x.com")]);
    save(dir, "zai", [api("k")]);
    save(dir, "not-a-provider", [oauth("x@y.com")]);
    save(dir, "anthropic", []); // delete anthropic
    const out = allProviders(dir);
    expect(out).toContain("zai");
    expect(out).not.toContain("anthropic");
    expect(out).not.toContain("not-a-provider");
  });

  test("returns empty when no credentials file exists", () => {
    const dir = dataDir();
    expect(allProviders(dir)).toEqual([]);
  });
});

describe("permissions warning", () => {
  test("warns to stderr when credentials file is group/world readable", () => {
    const dir = dataDir();
    save(dir, "anthropic", [oauth("a@x.com")]);
    const file = join(dir, "credentials.json");
    chmodSync(file, 0o644);
    const captured: string[] = [];
    const orig = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      load(dir, "anthropic");
    } finally {
      process.stderr.write = orig;
    }
    const joined = captured.join("");
    expect(joined).toContain("warning");
    expect(joined).toContain("credentials.json");
  });
});