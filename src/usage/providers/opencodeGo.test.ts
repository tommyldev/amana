import { describe, expect, test } from "bun:test";

import {
  OPENCODE_CONSOLE_BASE,
  OPENCODE_GO_STATUS_PATH,
} from "../../auth/oauth/opencode.ts";
import type { Credential } from "../../auth/types.ts";
import { openDb } from "../../db/db.ts";
import { insertEvents } from "../../db/usage.ts";
import { opencodeGoFetcher } from "./opencodeGo.ts";

const TOKEN = "access-fixture";

function makeCredential(overrides?: Partial<Extract<Credential, { type: "oauth" }>>): Credential {
  return {
    type: "oauth",
    access: TOKEN,
    refresh: "refresh-fixture",
    expires: Date.now() + 3_600_000,
    ...overrides,
  };
}

function makeGoStatusPayload(overrides?: Record<string, unknown>) {
  const resetsAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
  const windowStartsAt = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
  return {
    subscriberUserId: "u-123",
    subscriptionStatus: "active",
    durableBalanceFallbackEnabled: false,
    nextChargeMicroCents: 1200000000,
    recurringChargeMicroCents: 1200000000,
    meters: [
      {
        kind: "five_hour",
        windowStartsAt,
        resetsAt,
        limitMicroCents: 1200000000,
        settledMicroCents: 600000000,
        reservedMicroCents: 300000000,
        remainingMicroCents: 300000000,
      },
      {
        kind: "calendar_week",
        resetsAt,
        limitMicroCents: 3000000000,
        settledMicroCents: 1500000000,
        reservedMicroCents: 0,
        remainingMicroCents: 1500000000,
      },
      {
        kind: "product_period",
        resetsAt,
        limitMicroCents: 6000000000,
        settledMicroCents: 1200000000,
        reservedMicroCents: 0,
        remainingMicroCents: 4800000000,
      },
    ],
    availableActions: [],
    unavailableActions: [],
    ...overrides,
  };
}

type FetchCall = { url: string; headers: Record<string, string>; redirect?: RequestInit["redirect"] };

function statusRouter(opts: { body?: unknown; status?: number } = {}): {
  calls: FetchCall[];
  fetch: typeof globalThis.fetch;
} {
  const calls: FetchCall[] = [];
  const fetch = (async (input, init) => {
    const headers: Record<string, string> = {};
    const raw = init?.headers;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [key, value] of Object.entries(raw as Record<string, string>)) {
        headers[key.toLowerCase()] = value;
      }
    }
    calls.push({ url: String(input), headers, redirect: init?.redirect });
    return new Response(JSON.stringify(opts.body ?? makeGoStatusPayload()), {
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

describe("opencodeGoFetcher", () => {
  test("maps all three meter kinds to USD limits from /api/go/status", async () => {
    const payload = makeGoStatusPayload();
    const meters = payload.meters as Array<{ kind: string; windowStartsAt?: string; resetsAt: string }>;
    const resetsAt = meters[0].resetsAt;
    const windowStartsAt = meters[0].windowStartsAt as string;
    const { calls, fetch } = statusRouter({ body: payload });
    const report = await withFetch(fetch, () =>
      opencodeGoFetcher.fetch(makeCredential({ account_id: "acct-1", email: "me@example.com" }), openDb(":memory:")),
    );

    expect(report?.limits.map(l => l.id)).toEqual(["rolling-5h", "weekly", "monthly"]);
    expect(report?.limits.map(l => l.label)).toEqual(["5 Hour limit", "Weekly limit", "Monthly limit"]);
    expect(report?.limits.map(l => l.window?.label)).toEqual(["5 Hour", "Weekly", "Monthly"]);
    expect(report?.account).toBe("me@example.com");
    expect(report?.notes).toContain("OpenCode Go plan: active");

    const fiveHour = report?.limits[0];
    expect(fiveHour?.amount.used).toBe(9);
    expect(fiveHour?.amount.limit).toBe(12);
    expect(fiveHour?.amount.remaining).toBe(3);
    expect(fiveHour?.amount.usedFraction).toBe(0.75);
    expect(fiveHour?.amount.remainingFraction).toBe(0.25);
    expect(fiveHour?.amount.unit).toBe("usd");
    expect(fiveHour?.status).toBe("ok");
    expect(fiveHour?.window?.resetsAt).toBe(Date.parse(resetsAt));
    expect(fiveHour?.window?.durationMs).toBe(Date.parse(resetsAt) - Date.parse(windowStartsAt));

    const weekly = report?.limits[1];
    expect(weekly?.amount.used).toBe(15);
    expect(weekly?.amount.limit).toBe(30);
    expect(weekly?.amount.usedFraction).toBe(0.5);
    expect(weekly?.window?.resetsAt).toBe(Date.parse(resetsAt));
    expect(weekly?.window?.durationMs).toBe(7 * 24 * 60 * 60 * 1000);

    const monthly = report?.limits[2];
    expect(monthly?.amount.used).toBe(12);
    expect(monthly?.amount.limit).toBe(60);
    expect(monthly?.amount.usedFraction).toBeCloseTo(0.2, 5);
    expect(monthly?.window?.durationMs).toBe(30 * 24 * 60 * 60 * 1000);

    const call = calls[0];
    expect(call?.url).toBe(`${OPENCODE_CONSOLE_BASE}${OPENCODE_GO_STATUS_PATH}`);
    expect(call?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call?.redirect).toBe("error");
  });

  test("throws with a re-login hint on 401", async () => {
    const { fetch } = statusRouter({ status: 401 });
    const err = await withFetch(fetch, () => opencodeGoFetcher.fetch(makeCredential(), openDb(":memory:"))).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/401/);
    expect((err as Error).message).toMatch(/login/i);
  });

  test("throws with the status code on other non-2xx responses", async () => {
    const { fetch } = statusRouter({ status: 500 });
    const err = await withFetch(fetch, () => opencodeGoFetcher.fetch(makeCredential(), openDb(":memory:"))).catch(
      (e: unknown) => e,
    );
    expect((err as Error).message).toMatch(/HTTP 500/);
  });

  test("empty meters yields zero limits and an explanatory note", async () => {
    const { fetch } = statusRouter({ body: makeGoStatusPayload({ meters: [] }) });
    const report = await withFetch(fetch, () => opencodeGoFetcher.fetch(makeCredential(), openDb(":memory:")));
    expect(report?.limits).toEqual([]);
    expect(report?.notes).toContain("OpenCode Go plan reported no meters.");
  });

  test("notes durable balance fallback when enabled", async () => {
    const { fetch } = statusRouter({ body: makeGoStatusPayload({ durableBalanceFallbackEnabled: true }) });
    const report = await withFetch(fetch, () => opencodeGoFetcher.fetch(makeCredential(), openDb(":memory:")));
    expect(report?.notes).toContain("Durable balance fallback is enabled.");
  });

  test("passes unknown meter kinds through with derived ids and labels", async () => {
    const { fetch } = statusRouter({
      body: makeGoStatusPayload({
        meters: [
          {
            kind: "hourly",
            limitMicroCents: 100000000,
            settledMicroCents: 25000000,
            reservedMicroCents: 0,
            remainingMicroCents: 75000000,
          },
        ],
      }),
    });
    const report = await withFetch(fetch, () => opencodeGoFetcher.fetch(makeCredential(), openDb(":memory:")));
    expect(report?.limits.map(l => l.id)).toEqual(["meter-0"]);
    expect(report?.limits[0]?.label).toBe("Hourly limit");
    expect(report?.limits[0]?.amount.limit).toBe(1);
    expect(report?.limits[0]?.amount.used).toBe(0.25);
    expect(report?.limits[0]?.amount.usedFraction).toBe(0.25);
    expect(report?.limits[0]?.status).toBe("ok");
  });

  test("returns null for an oauth credential without an access token", async () => {
    const report = await opencodeGoFetcher.fetch(makeCredential({ access: "   " }), openDb(":memory:"));
    expect(report).toBeNull();
  });

  test("api_key credentials keep the local OMP sqlite path", async () => {
    const db = openDb(":memory:");
    const now = Date.now();
    insertEvents(db, [
      {
        source: "omp",
        source_message_id: "evt-1",
        timestamp_ms: now - 60_000,
        provider: "opencode-go",
        model: "m",
        prompt_tokens: 100,
        completion_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        total_tokens: 100,
        cost_usd: 2,
        cost_origin: "logged",
      },
    ]);
    const report = await opencodeGoFetcher.fetch({ type: "api_key", key: "k", account: "acct" }, db);
    expect(report?.limits.map(l => l.id)).toEqual(["rolling-5h", "weekly", "monthly"]);
    expect(report?.limits[0]?.amount.used).toBe(2);
    expect(report?.limits[0]?.amount.limit).toBe(12);
    expect(report?.notes).toContain("OMP-observed spend only; OpenCode usage outside OMP is not included.");
    expect(report?.notes).toContain("Run the OpenCode Go OAuth login for real plan quota.");
    db.close();
  });
});
