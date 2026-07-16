import type { Database } from "bun:sqlite";
import type { Config, ProviderCfg } from "../config/types.ts";
import { buildSnapshot, soonest, type ProviderView } from "./snapshot.ts";
import { bar, costStr, fmtDuration, fmtTokens, usedStr } from "./format.ts";

function renderLine(prov: ProviderCfg, view: ProviderView, nowMs: number): string | undefined {
  const w = soonest(view);
  if (!w.active) return undefined;
  const resetSecs = Math.max(Math.floor((w.active.nextReset - nowMs) / 1000), 0);
  const pct = String(Math.round(w.pct)).padStart(3, " ");
  return `${view.id}   [${w.desc}]   resets in ${fmtDuration(resetSecs)}   ${bar(w.pct)} ${pct}%  ·  ${usedStr(prov, w.usage)} ${costStr(prov, w.usage)}`;
}

/** Render the `atop report` text output (port of Rust `report::render_report`). */
export function renderReport(db: Database, cfg: Config, nowMs: number): string {
  const snap = buildSnapshot(db, cfg, nowMs);
  let s = `today: ${snap.today.requests} req  ${fmtTokens(snap.today.total)} tok  $${snap.today.cost.toFixed(2)}\n`;
  s += "---\n";
  for (let i = 0; i < cfg.providers.length; i++) {
    const prov = cfg.providers[i]!;
    const view = snap.providers[i]!;
    if (!view.enabled) continue;
    const line = renderLine(prov, view, nowMs);
    if (line !== undefined) s += line + "\n";
  }
  return s;
}
