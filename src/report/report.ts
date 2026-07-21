import type { Database } from "bun:sqlite";
import type { Config } from "../config/types.ts";
import { buildSnapshot, type ProviderView, type WindowView } from "./snapshot.ts";
import { bar, fmtDuration, fmtTokens } from "./format.ts";

/**
 * Usage string for a single window, using THAT window's own token limit.
 * Only the primary window carries a limit (see snapshot.ts::buildView), so
 * secondary windows render usage-only — never borrowing the primary's cap.
 */
function windowUsed(w: WindowView): string {
  if (w.tokenLimit !== undefined) return `${fmtTokens(w.usage.total)} / ${fmtTokens(w.tokenLimit)} tok`;
  return `${fmtTokens(w.usage.total)} tok`;
}

function renderWindowLine(id: string, w: WindowView, nowMs: number): string | undefined {
  if (!w.active) return undefined;
  const resetSecs = Math.max(Math.floor((w.active.nextReset - nowMs) / 1000), 0);
  const head = `${id}   [${w.desc}]   resets in ${fmtDuration(resetSecs)}`;
  // Each window shows its OWN cost; the monthly cost cap is a separate line, so
  // per-window cost is never compared to the (monthly) budget.
  const cost = w.usage.cost > 0 ? `$${w.usage.cost.toFixed(2)}` : "-";
  const tail = `${windowUsed(w)} ${cost}`;
  // A percent bar only means something against a configured token limit; a
  // limitless window shows usage-only (no "0% of nothing" bar).
  if (w.tokenLimit === undefined) return `${head}   ·  ${tail}`;
  const pct = String(Math.round(w.pct)).padStart(3, " ");
  return `${head}   ${bar(w.pct)} ${pct}%  ·  ${tail}`;
}

/** Monthly cost cap line ($spend / $cap vs this month's spend), when configured. */
function renderCostLine(view: ProviderView): string | undefined {
  const cap = view.monthlyCostLimit;
  if (cap === undefined) return undefined;
  const used = view.monthCostUsed ?? 0;
  const pctNum = cap > 0 ? Math.min((used / cap) * 100, 100) : 0;
  const pct = String(Math.round(pctNum)).padStart(3, " ");
  return `${view.id}   [monthly cost]   ${bar(pctNum)} ${pct}%  ·  $${used.toFixed(2)} / $${cap.toFixed(2)}`;
}

/**
 * Render the `amana report` text output. One status line per CONFIGURED window
 * (usage_window + each extra_window) for every enabled provider, plus a monthly
 * cost cap line when one is set.
 */
export function renderReport(db: Database, cfg: Config, nowMs: number): string {
  const snap = buildSnapshot(db, cfg, nowMs);
  let s = `today: ${snap.today.requests} req  ${fmtTokens(snap.today.total)} tok  $${snap.today.cost.toFixed(2)}\n`;
  s += "---\n";
  for (let i = 0; i < cfg.providers.length; i++) {
    const view = snap.providers[i]!;
    if (!view.enabled) continue;
    for (const w of view.windows) {
      const line = renderWindowLine(view.id, w, nowMs);
      if (line !== undefined) s += line + "\n";
    }
    const cost = renderCostLine(view);
    if (cost !== undefined) s += cost + "\n";
  }
  return s;
}
