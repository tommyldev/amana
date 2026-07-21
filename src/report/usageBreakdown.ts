/**
 * Colored per-provider / per-account usage breakdown for `amana usage`.
 * Adopts oh-my-pi's `omp usage` layout: status dots, block bars, amounts,
 * reset times, and per-window capacity stats. Ported from
 * `oh-my-pi/packages/coding-agent/src/cli/usage-cli.ts`, adapted to atop's
 * usage model (no metadata/resetCredits/redaction).
 */
import {
  resolveUsedFraction,
  statusOf,
  type UsageLimit,
  type UsageReport,
  type UsageStatus,
  type UsageUnit,
} from "../usage/types.ts";
import { fmtDuration, fmtTokens } from "./format.ts";
import { bold, boldCyan, dim, green, red, yellow } from "./ansi.ts";

const BAR_WIDTH = 28;
const STALE_MS = 90_000;

function resolveStatus(limit: UsageLimit): UsageStatus {
  if (limit.status && limit.status !== "unknown") return limit.status;
  return statusOf(resolveUsedFraction(limit));
}

const STATUS_COLOR: Record<UsageStatus, (t: string) => string> = {
  exhausted: red,
  warning: yellow,
  ok: green,
  unknown: dim,
};

/** Worst-of aggregation: exhausted > warning > ok > unknown. */
function aggregateStatus(limits: UsageLimit[]): UsageStatus {
  const statuses = limits.map(resolveStatus);
  if (statuses.includes("exhausted")) return "exhausted";
  if (statuses.includes("warning")) return "warning";
  if (statuses.includes("ok")) return "ok";
  return "unknown";
}

function formatProviderName(provider: string): string {
  return provider
    .split(/[-_]/g)
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : ""))
    .join(" ");
}

const UNIT_SUFFIX: Record<UsageUnit, string> = {
  tokens: " tokens",
  requests: " requests",
  minutes: " min",
  bytes: " bytes",
  percent: "",
  usd: "",
  unknown: "",
};

function formatUnitValue(value: number, unit: UsageUnit): string {
  if (unit === "usd") return `$${value.toFixed(2)}`;
  return fmtTokens(value);
}

function describeAmount(limit: UsageLimit): string {
  const a = limit.amount;
  const parts: string[] = [];
  const absolute = a.unit !== "percent" && a.unit !== "unknown";
  if (absolute && a.used !== undefined && a.limit !== undefined) {
    parts.push(`${formatUnitValue(a.used, a.unit)} / ${formatUnitValue(a.limit, a.unit)}${UNIT_SUFFIX[a.unit]}`);
  } else if (absolute && a.remaining !== undefined) {
    parts.push(`${formatUnitValue(a.remaining, a.unit)}${UNIT_SUFFIX[a.unit]} left`);
  }
  const fraction = resolveUsedFraction(limit);
  if (fraction !== undefined) parts.push(`${(fraction * 100).toFixed(1)}% used`);
  else if (a.remainingFraction !== undefined) parts.push(`${(a.remainingFraction * 100).toFixed(1)}% left`);
  if (parts.length === 0) parts.push("no data");
  return parts.join(" · ");
}

function renderBar(limit: UsageLimit): string {
  const fraction = resolveUsedFraction(limit);
  if (fraction === undefined) return dim("·".repeat(BAR_WIDTH));
  const filled = Math.round(fraction * BAR_WIDTH);
  return STATUS_COLOR[resolveStatus(limit)]("█".repeat(filled)) + dim("░".repeat(BAR_WIDTH - filled));
}

/** Append tier/window to the limit label when not already present. */
function limitTitle(limit: UsageLimit): string {
  let label = limit.label;
  const tier = limit.tier ?? limit.scope.tier;
  if (tier && !label.toLowerCase().includes(tier.toLowerCase())) label = `${label} (${tier})`;
  const windowLabel = limit.window?.label ?? limit.scope.windowId;
  if (!windowLabel) return label;
  if (windowLabel.toLowerCase() === "quota window") return label;
  if (label.toLowerCase().includes(windowLabel.toLowerCase())) return label;
  return `${label} (${windowLabel})`;
}

function durationLabel(ms: number): string {
  return fmtDuration(Math.floor(ms / 1000));
}

function formatAccountHeader(report: UsageReport, nowMs: number): string {
  const icon = STATUS_COLOR[aggregateStatus(report.limits)]("●");
  let header = `${icon} ${bold(report.account)}`;
  if (report.fetchedAt && nowMs - report.fetchedAt > STALE_MS) {
    header += dim(` · fetched ${durationLabel(nowMs - report.fetchedAt)} ago`);
  }
  return header;
}

function formatLimitLine(limit: UsageLimit, labelWidth: number, nowMs: number): string[] {
  const status = resolveStatus(limit);
  const details = [describeAmount(limit)];
  const resetsAt = limit.window?.resetsAt;
  if (resetsAt !== undefined && resetsAt > nowMs) details.push(`resets in ${durationLabel(resetsAt - nowMs)}`);
  const lines = [
    `      ${STATUS_COLOR[status]("●")} ${limitTitle(limit).padEnd(labelWidth)}  ${renderBar(limit)}  ${dim(details.join(" · "))}`,
  ];
  if (limit.notes.length > 0) lines.push(`        ${dim(limit.notes.join(" · "))}`);
  return lines;
}

interface ProviderLimitTemplate {
  id: string;
  title: string;
}

function collectProviderLimitTemplates(reports: UsageReport[]): ProviderLimitTemplate[] {
  const seen = new Set<string>();
  const templates: ProviderLimitTemplate[] = [];
  for (const report of reports) {
    for (const limit of report.limits) {
      if (seen.has(limit.id)) continue;
      seen.add(limit.id);
      templates.push({ id: limit.id, title: limitTitle(limit) });
    }
  }
  return templates;
}

function formatMissingLimitLine(template: ProviderLimitTemplate, labelWidth: number): string {
  return `      ${dim("○")} ${template.title.padEnd(labelWidth)}  ${dim("·".repeat(BAR_WIDTH))}  ${dim("not reported")}`;
}

export interface ProviderWindowStat {
  window: string;
  durationMs?: number;
  accounts: number;
  usedAccounts: number;
  remainingAccounts: number;
}

/** Aggregate one provider's reports into per-window quota capacity stats. */
export function computeProviderWindowStats(reports: UsageReport[]): ProviderWindowStat[] {
  const buckets = new Map<string, { window: string; durationMs?: number; fractions: number[] }>();
  for (const report of reports) {
    const accountMax = new Map<string, number>();
    for (const limit of report.limits) {
      const fraction = resolveUsedFraction(limit);
      if (fraction === undefined) continue;
      const durationMs = limit.window?.durationMs;
      const key = durationMs !== undefined ? `d:${durationMs}` : (limit.scope.windowId ?? limit.window?.label ?? limit.label);
      const previous = accountMax.get(key);
      if (previous === undefined || fraction > previous) accountMax.set(key, fraction);
      if (!buckets.has(key)) {
        const window = durationMs !== undefined ? durationLabel(durationMs) : (limit.window?.label ?? limit.scope.windowId ?? limit.label);
        buckets.set(key, { window, durationMs, fractions: [] });
      }
    }
    for (const [key, fraction] of accountMax) buckets.get(key)!.fractions.push(fraction);
  }
  return [...buckets.values()]
    .sort((a, b) => (a.durationMs ?? Number.POSITIVE_INFINITY) - (b.durationMs ?? Number.POSITIVE_INFINITY))
    .map((bucket) => {
      const usedAccounts = bucket.fractions.reduce((sum, f) => sum + f, 0);
      return {
        window: bucket.window,
        durationMs: bucket.durationMs,
        accounts: bucket.fractions.length,
        usedAccounts,
        remainingAccounts: Math.max(0, bucket.fractions.length - usedAccounts),
      };
    });
}

/** Render the full text breakdown: per provider, per account, every limit. */
export function formatUsageBreakdown(reports: UsageReport[], nowMs: number): string {
  const byProvider = new Map<string, UsageReport[]>();
  for (const report of reports) {
    const list = byProvider.get(report.provider) ?? [];
    list.push(report);
    byProvider.set(report.provider, list);
  }
  const providers = [...byProvider.keys()].sort((a, b) => a.localeCompare(b));

  const lines: string[] = [];
  const latestFetchedAt = Math.max(0, ...reports.map((r) => r.fetchedAt ?? 0));
  const headerSuffix = latestFetchedAt ? dim(` · fetched ${durationLabel(nowMs - latestFetchedAt)} ago`) : "";
  lines.push(`${bold("Usage")}${headerSuffix}`);

  for (const provider of providers) {
    const providerReports = byProvider.get(provider) ?? [];
    const count = providerReports.length;
    lines.push("");
    lines.push(`${boldCyan(formatProviderName(provider))} ${dim(`— ${count} ${count === 1 ? "account" : "accounts"}`)}`);

    const providerNotes = [...new Set(providerReports.flatMap((r) => r.notes))];
    for (const note of providerNotes) lines.push(`  ${dim(note.replace(/[\r\n]+/g, " ").replace(/\t/g, "  "))}`);

    const templates = collectProviderLimitTemplates(providerReports);
    const labelWidth = templates.reduce((max, t) => Math.max(max, t.title.length), 0);

    for (const report of providerReports) {
      lines.push(`  ${formatAccountHeader(report, nowMs)}`);
      if (report.limits.length === 0) {
        lines.push(`      ${dim("no limits reported")}`);
        continue;
      }
      const limitsById = new Map(report.limits.map((l) => [l.id, l] as const));
      for (const template of templates) {
        const limit = limitsById.get(template.id);
        if (limit) lines.push(...formatLimitLine(limit, labelWidth, nowMs));
        else lines.push(formatMissingLimitLine(template, labelWidth));
      }
    }

    const stats = computeProviderWindowStats(providerReports);
    if (stats.length > 0) {
      const parts = stats.map(
        (s) =>
          `${s.window} → ${s.usedAccounts.toFixed(2)}/${s.accounts} ${s.accounts === 1 ? "account" : "accounts"} used (${s.remainingAccounts.toFixed(2)}× quota left)`,
      );
      lines.push(`  ${dim(`capacity: ${parts.join(" · ")}`)}`);
    }
  }

  return lines.join("\n");
}
