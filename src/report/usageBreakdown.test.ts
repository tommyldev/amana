import { describe, expect, test } from "bun:test";
import { computeProviderWindowStats, formatUsageBreakdown } from "./usageBreakdown.ts";
import { stripAnsi } from "./ansi.ts";
import type { UsageLimit, UsageReport } from "../usage/types.ts";

const NOW = 1_700_000_000_000;

function limit(over: Partial<UsageLimit> & { id: string; label: string }): UsageLimit {
  return {
    tier: undefined,
    scope: { provider: "anthropic", shared: false },
    status: "unknown",
    notes: [],
    amount: { unit: "percent" },
    ...over,
  } as UsageLimit;
}

function reports(): UsageReport[] {
  return [
    {
      provider: "anthropic",
      account: "alice@example.com",
      fetchedAt: NOW,
      notes: [],
      limits: [
        limit({
          id: "five_h",
          label: "5h",
          window: { id: "5h", label: "5h", durationMs: 18_000_000, resetsAt: NOW + 3_600_000 },
          amount: { usedFraction: 0.93, unit: "percent" },
        }),
        limit({
          id: "cost",
          label: "Monthly cost",
          amount: { used: 12.5, limit: 50, unit: "usd" },
        }),
      ],
    },
    {
      // Second account is missing the "cost" limit → renders as "not reported".
      provider: "anthropic",
      account: "bob@example.com",
      fetchedAt: NOW,
      notes: [],
      limits: [
        limit({
          id: "five_h",
          label: "5h",
          window: { id: "5h", label: "5h", durationMs: 18_000_000 },
          amount: { usedFraction: 0.1, unit: "percent" },
        }),
      ],
    },
  ];
}

describe("formatUsageBreakdown", () => {
  const out = () => stripAnsi(formatUsageBreakdown(reports(), NOW));

  test("shows the provider display name and account count", () => {
    expect(out()).toContain("Anthropic");
    expect(out()).toContain("— 2 accounts");
  });

  test("renders filled and empty bar glyphs", () => {
    expect(out()).toContain("█");
    expect(out()).toContain("░");
  });

  test("shows percent used and reset time", () => {
    expect(out()).toContain("93.0% used");
    expect(out()).toContain("resets in");
  });

  test("renders absolute usd amounts", () => {
    expect(out()).toContain("$12.50 / $50.00");
  });

  test("marks a missing limit as not reported with an empty circle", () => {
    const text = out();
    expect(text).toContain("not reported");
    expect(text).toContain("○");
  });

  test("draws a status dot for each account header", () => {
    expect(out()).toContain("●");
  });

  test("appends a per-window capacity line", () => {
    const text = out();
    expect(text).toContain("capacity:");
    // Two accounts report the 5h window; used = 0.93 + 0.10 = 1.03.
    expect(text).toContain("1.03/2 accounts used");
  });
});

describe("computeProviderWindowStats", () => {
  test("buckets by window duration and sums per-account fractions", () => {
    const stats = computeProviderWindowStats(reports());
    const fiveH = stats.find((s) => s.durationMs === 18_000_000);
    expect(fiveH).toBeDefined();
    expect(fiveH!.accounts).toBe(2);
    expect(fiveH!.usedAccounts).toBeCloseTo(1.03, 5);
    expect(fiveH!.remainingAccounts).toBeCloseTo(0.97, 5);
  });
});

describe("ansi", () => {
  test("stripAnsi removes SGR sequences", () => {
    expect(stripAnsi("\x1b[31mx\x1b[0m")).toBe("x");
  });
});
