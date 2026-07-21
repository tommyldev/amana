export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toFixed(0);
}

export function fmtDuration(secs: number): string {
  if (secs <= 0) return "now";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 24) {
    const d = Math.floor(h / 24);
    const hr = h % 24;
    return `${d}d ${String(hr).padStart(2, "0")}h`;
  }
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m`;
}

/** 10-cell block-glyph bar for a 0..100 percentage. */
export function bar(pct: number): string {
  const p = Math.min(Math.max(Math.round(pct / 10), 0), 10);
  return "█".repeat(p) + "░".repeat(10 - p);
}

export function truncate(s: string, max: number): string {
  const chars = [...s];
  if (chars.length <= max) return s;
  return chars.slice(0, Math.max(max - 1, 0)).join("") + "…";
}

/** Percent of a token limit consumed, clamped to 100; 0 when no limit set. */
export function pctOf(total: number, limit: number | undefined): number {
  if (limit === undefined || limit <= 0) return 0;
  return Math.min((total / limit) * 100, 100);
}
