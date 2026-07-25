import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { buildXaiCliBillingUrl } from "../../auth/oauth/xai.ts";
import type { Credential } from "../../auth/types.ts";
import { xaiOauthFetcher } from "./xaiOauth.ts";

const USER_ID = "cf12ecb5-cca4-4ba0-9f02-298071a2d052";

const accessTokenFixture = (() => {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ sub: USER_ID })).toString("base64url");
  return `${header}.${body}.sig`;
})();

type FetchCall = { url: string; headers: Record<string, string>; redirect?: RequestInit["redirect"] };

function makeBillingPayload(overrides?: Record<string, unknown>) {
  const periodEnd = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
  const periodStart = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  return {
    config: {
      creditUsagePercent: 18,
      currentPeriod: { end: periodEnd, start: periodStart, type: "USAGE_PERIOD_TYPE_WEEKLY" },
      productUsage: [
        { product: "GrokBuild", usagePercent: 16 },
        { product: "Api", usagePercent: 2 },
      ],
      ...overrides,
    },
  };
}

function makeUnifiedCreditsPayload() {
  return {
    config: {
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-07-23T11:11:10.769917+00:00",
        end: "2026-07-30T11:11:10.769917+00:00",
      },
      onDemandCap: { val: 0 },
      onDemandUsed: { val: 0 },
      isUnifiedBillingUser: true,
      prepaidBalance: { val: 0 },
      topUpMethod: "TOP_UP_METHOD_SAVED_PAYMENT_METHOD",
      billingPeriodStart: "2026-07-23T11:11:10.769917+00:00",
      billingPeriodEnd: "2026-07-30T11:11:10.769917+00:00",
    },
  };
}

function makeUnifiedMonthlyPayload(overrides?: Record<string, unknown>) {
  return {
    config: {
      monthlyLimit: { val: 15000 },
      used: { val: 10548 },
      onDemandCap: { val: 0 },
      billingPeriodStart: "2026-07-01T00:00:00+00:00",
      billingPeriodEnd: "2026-08-01T00:00:00+00:00",
      history: [],
      ...overrides,
    },
  };
}

function makeCredential(overrides?: Partial<Extract<Credential, { type: "oauth" }>>): Credential {
  return {
    type: "oauth",
    access: accessTokenFixture,
    refresh: "refresh-fixture",
    expires: Date.now() + 3_600_000,
    ...overrides,
  };
}

interface RouterOptions {
  credits?: unknown;
  monthly?: unknown;
  userinfo?: unknown;
  status?: number;
}

function billingRouter(opts: RouterOptions): { calls: FetchCall[]; fetch: typeof globalThis.fetch } {
  const calls: FetchCall[] = [];
  const fetch = (async (input, init) => {
    const headers: Record<string, string> = {};
    const raw = init?.headers;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [key, value] of Object.entries(raw as Record<string, string>)) {
        headers[key.toLowerCase()] = value;
      }
    }
    const url = String(input);
    calls.push({ url, headers, redirect: init?.redirect });
    let body: unknown;
    if (url.includes("/oauth2/userinfo")) body = opts.userinfo ?? { sub: USER_ID, email: "user@example.com" };
    else if (url.includes("format=credits")) body = opts.credits ?? makeBillingPayload();
    else body = opts.monthly ?? makeUnifiedMonthlyPayload();
    return new Response(JSON.stringify(body), {
      status: opts.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

function withFetch<T>(fetch: typeof globalThis.fetch, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = fetch;
  return fn().finally(() => {
    globalThis.fetch = orig;
  });
}

const DB = {} as Database;

describe("xaiOauthFetcher", () => {
  test("maps weekly credit and product usage with CLI-aligned billing headers", async () => {
    const { calls, fetch } = billingRouter({});
    const report = await withFetch(fetch, () => xaiOauthFetcher.fetch(makeCredential(), DB));

    expect(report?.limits.map(l => l.id)).toEqual([
      "xai-oauth:credits:1w",
      "xai-oauth:product:grokbuild:1w",
      "xai-oauth:product:api:1w",
    ]);
    expect(report?.limits[0]?.amount.usedFraction).toBeCloseTo(0.18, 5);
    expect(report?.account).toBe("user@example.com");

    const billingCall = calls.find(c => c.url.includes("/v1/billing") && c.url.includes("format=credits"));
    expect(billingCall?.url).toBe(buildXaiCliBillingUrl());
    expect(billingCall?.headers).toEqual({
      authorization: `Bearer ${accessTokenFixture}`,
      accept: "application/json",
      "x-xai-token-auth": "xai-grok-cli",
    });
    expect(billingCall?.redirect).toBe("error");
    expect(calls.filter(c => c.url.includes("/v1/billing"))).toHaveLength(1);
  });

  test("uses a stored email without an extra userinfo request", async () => {
    const { calls, fetch } = billingRouter({});
    const report = await withFetch(fetch, () =>
      xaiOauthFetcher.fetch(makeCredential({ account_id: "stored-account", email: "stored@example.com" }), DB),
    );

    expect(report?.account).toBe("stored@example.com");
    expect(calls.some(c => c.url.includes("/oauth2/userinfo"))).toBe(false);
  });

  test("maps a positive on-demand cap", async () => {
    const { fetch } = billingRouter({
      credits: makeBillingPayload({ onDemandCap: { val: 50 }, onDemandUsed: { val: 10 } }),
    });
    const report = await withFetch(fetch, () => xaiOauthFetcher.fetch(makeCredential(), DB));

    const onDemand = report?.limits.find(l => l.id === "xai-oauth:on-demand");
    expect(onDemand?.amount.used).toBe(10);
    expect(onDemand?.amount.limit).toBe(50);
    expect(onDemand?.amount.usedFraction).toBeCloseTo(0.2, 5);
  });

  test("still reports usage when the weekly period has just ended", async () => {
    const periodEnd = new Date(Date.now() - 60_000).toISOString();
    const periodStart = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const { fetch } = billingRouter({
      credits: makeBillingPayload({
        currentPeriod: { end: periodEnd, start: periodStart, type: "USAGE_PERIOD_TYPE_WEEKLY" },
      }),
    });
    const report = await withFetch(fetch, () => xaiOauthFetcher.fetch(makeCredential(), DB));

    expect(report?.limits[0]?.id).toBe("xai-oauth:credits:1w");
    expect(report?.limits[0]?.window?.resetsAt).toBe(Date.parse(periodEnd));
  });

  test("falls back to monthly included quota when credits has no percent fields", async () => {
    const { calls, fetch } = billingRouter({
      credits: makeUnifiedCreditsPayload(),
      monthly: makeUnifiedMonthlyPayload(),
    });
    const report = await withFetch(fetch, () =>
      xaiOauthFetcher.fetch(makeCredential({ account_id: "stored-account", email: "stored@example.com" }), DB),
    );

    expect(calls.map(c => c.url).filter(u => u.includes("/v1/billing"))).toEqual([
      buildXaiCliBillingUrl(),
      buildXaiCliBillingUrl(""),
    ]);
    expect(report?.limits.map(l => l.id)).toEqual(["xai-oauth:included:1mo"]);

    const included = report?.limits[0];
    expect(included?.label).toBe("SuperGrok Monthly Included");
    expect(included?.amount.used).toBe(10548);
    expect(included?.amount.limit).toBe(15000);
    expect(included?.amount.remaining).toBe(4452);
    expect(included?.amount.usedFraction).toBeCloseTo(10548 / 15000, 5);
    expect(included?.window?.id).toBe("1mo");
    expect(included?.window?.label).toBe("Monthly");
    expect(included?.window?.resetsAt).toBe(Date.parse("2026-08-01T00:00:00+00:00"));
    expect(included?.status).toBe("ok");
  });

  test("merges weekly credits with monthly included when a unified account returns both", async () => {
    const creditsBoth = {
      config: {
        ...makeUnifiedCreditsPayload().config,
        creditUsagePercent: 2,
        productUsage: [{ product: "Api", usagePercent: 2 }],
      },
    };
    const { calls, fetch } = billingRouter({ credits: creditsBoth, monthly: makeUnifiedMonthlyPayload() });
    const report = await withFetch(fetch, () =>
      xaiOauthFetcher.fetch(makeCredential({ email: "stored@example.com" }), DB),
    );

    expect(calls.map(c => c.url).filter(u => u.includes("/v1/billing"))).toEqual([
      buildXaiCliBillingUrl(),
      buildXaiCliBillingUrl(""),
    ]);
    expect(report?.limits.map(l => l.id)).toEqual([
      "xai-oauth:credits:1w",
      "xai-oauth:product:api:1w",
      "xai-oauth:included:1mo",
    ]);
    expect(report?.limits[0]?.amount.usedFraction).toBeCloseTo(0.02, 5);
    expect(report?.limits[2]?.amount.used).toBe(10548);
    expect(report?.limits[2]?.amount.limit).toBe(15000);
  });

  test("maps unified monthly on-demand when the included quota payload carries a positive cap", async () => {
    const { fetch } = billingRouter({
      credits: makeUnifiedCreditsPayload(),
      monthly: makeUnifiedMonthlyPayload({ onDemandCap: { val: 100 }, onDemandUsed: { val: 25 } }),
    });
    const report = await withFetch(fetch, () => xaiOauthFetcher.fetch(makeCredential(), DB));

    expect(report?.limits.map(l => l.id)).toEqual(["xai-oauth:included:1mo", "xai-oauth:on-demand"]);
    const onDemand = report?.limits.find(l => l.id === "xai-oauth:on-demand");
    expect(onDemand?.amount.used).toBe(25);
    expect(onDemand?.amount.limit).toBe(100);
    expect(onDemand?.amount.usedFraction).toBeCloseTo(0.25, 5);
  });

  test("returns null when both credits and monthly billing shapes are unusable", async () => {
    const { fetch } = billingRouter({
      credits: makeUnifiedCreditsPayload(),
      monthly: { config: { isUnifiedBillingUser: true, monthlyLimit: { val: 0 }, used: { val: 0 } } },
    });
    const report = await withFetch(fetch, () => xaiOauthFetcher.fetch(makeCredential(), DB));
    expect(report).toBeNull();
  });

  test("skips expired OAuth tokens and returns null for rejected billing", async () => {
    const expired = await withFetch(billingRouter({}).fetch, () =>
      xaiOauthFetcher.fetch(makeCredential({ expires: Date.now() - 1 }), DB),
    );
    expect(expired).toBeNull();

    const denied = (async () => new Response("denied", { status: 403 })) as unknown as typeof globalThis.fetch;
    const report = await withFetch(denied, () => xaiOauthFetcher.fetch(makeCredential(), DB));
    expect(report).toBeNull();
  });

  test("returns null for api_key credentials", async () => {
    const report = await withFetch(billingRouter({}).fetch, () =>
      xaiOauthFetcher.fetch({ type: "api_key", key: "k" }, DB),
    );
    expect(report).toBeNull();
  });
});
