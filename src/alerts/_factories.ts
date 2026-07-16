import type {
  UsageAmount,
  UsageLimit,
  UsageReport,
  UsageScope,
  UsageWindow,
} from "../usage/types.ts";

export function makeAmount(usedFraction: number): UsageAmount {
  return { usedFraction, unit: "percent" };
}

export function makeWindow(resetsAt: number | undefined): UsageWindow | undefined {
  return resetsAt === undefined ? undefined : { id: "w", label: "5h", resetsAt };
}

export function makeLimit(opts: {
  id: string;
  label: string;
  usedFraction: number;
  resetsAt?: number;
}): UsageLimit {
  const scope: UsageScope = { provider: "anthropic", shared: false };
  return {
    id: opts.id,
    label: opts.label,
    scope,
    ...(opts.resetsAt !== undefined ? { window: makeWindow(opts.resetsAt)! } : {}),
    amount: makeAmount(opts.usedFraction),
    status: "warning",
    notes: [],
  };
}

export function makeReport(limits: UsageLimit[], account = "u1"): UsageReport {
  return { provider: "anthropic", account, fetchedAt: Date.now(), limits, notes: [] };
}