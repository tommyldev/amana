import { test, expect, describe } from "bun:test";
import type { AccountRow } from "../state.ts";
import { buildDetailRows, buildProviderRows, methodsFor } from "./providerList.ts";

const acct = (provider: string, label: string): AccountRow => ({
  provider,
  label,
  kind: "oauth",
  expiry: "no expiry",
});

describe("methodsFor", () => {
  test("maps each login kind to its methods", () => {
    expect(methodsFor("anthropic")).toEqual(["oauth"]);
    expect(methodsFor("zai")).toEqual(["apiKey"]);
    expect(methodsFor("openai-codex")).toEqual(["oauth", "apiKey"]);
    expect(methodsFor("openai-api")).toEqual(["adminKey"]);
  });

  test("unknown provider has no methods", () => {
    expect(methodsFor("not-a-provider")).toEqual([]);
  });
});

describe("buildProviderRows", () => {
  test("connected providers sort before disconnected", () => {
    const rows = buildProviderRows([acct("zai", "a@b.co")], "");
    expect(rows[0]!.id).toBe("zai");
    expect(rows[0]!.accounts).toHaveLength(1);
    expect(rows.slice(1).every((r) => r.accounts.length === 0)).toBe(true);
  });

  test("filter matches id or label, case-insensitive", () => {
    const rows = buildProviderRows([], "anthro");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.id.includes("anthro") || r.label.toLowerCase().includes("anthro"))).toBe(true);
  });

  test("empty filter returns every loginable provider", () => {
    expect(buildProviderRows([], "").length).toBeGreaterThanOrEqual(10);
  });
});

describe("buildDetailRows", () => {
  test("accounts precede add-actions", () => {
    const rows = buildDetailRows("openai-codex", [acct("openai-codex", "x@y.co")]);
    expect(rows[0]).toEqual({ kind: "account", account: acct("openai-codex", "x@y.co") });
    expect(rows.slice(1)).toEqual([
      { kind: "action", method: "oauth" },
      { kind: "action", method: "apiKey" },
    ]);
  });

  test("only this provider's accounts appear", () => {
    const rows = buildDetailRows("anthropic", [acct("zai", "z"), acct("anthropic", "a")]);
    const accounts = rows.filter((r) => r.kind === "account");
    expect(accounts).toHaveLength(1);
  });
});
