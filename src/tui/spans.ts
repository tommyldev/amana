export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export interface Span {
  id: string;
  label: string;
  hours: number | null;
}

export const SPANS: Span[] = [
  { id: "12h", label: "12h", hours: 12 },
  { id: "24h", label: "24h", hours: 24 },
  { id: "48h", label: "48h", hours: 48 },
  { id: "7d", label: "7d", hours: 7 * 24 },
  { id: "30d", label: "30d", hours: 30 * 24 },
  { id: "90d", label: "90d", hours: 90 * 24 },
  { id: "all", label: "all", hours: null },
];

export const DEFAULT_SPAN_ID = "24h";

export function spanById(id: string): Span {
  return SPANS.find((s) => s.id === id) ?? SPANS.find((s) => s.id === DEFAULT_SPAN_ID)!;
}

export function nextSpanId(id: string): string {
  const idx = SPANS.findIndex((s) => s.id === id);
  return SPANS[((idx < 0 ? 0 : idx) + 1) % SPANS.length]!.id;
}

export function isAllTime(span: Span): boolean {
  return span.hours === null;
}

/** Display/series bucket granularity for a span, in hours. */
export function bucketHours(span: Span): number {
  if (span.hours === null) return 24;
  if (span.hours <= 48) return 1;
  if (span.hours <= 168) return 4;
  return 24;
}

export interface SpanWindow {
  startMs: number;
  endMs: number;
  bucketMs: number;
  buckets: number;
}

/**
 * Window + bucket shape for a span. Bounded spans align start to the bucket
 * boundary; all-time starts at `earliestMs` (min event timestamp) and widens
 * buckets past a day so the chart stays ≤ ~90 columns.
 */
export function spanWindow(span: Span, nowMs: number, earliestMs?: number): SpanWindow {
  if (span.hours === null) return allTimeWindow(nowMs, earliestMs);
  const bucketMs = bucketHours(span) * HOUR_MS;
  const buckets = Math.ceil(span.hours / bucketHours(span));
  const startMs = Math.floor(nowMs / bucketMs) * bucketMs - (buckets - 1) * bucketMs;
  return { startMs, endMs: startMs + buckets * bucketMs, bucketMs, buckets };
}

function allTimeWindow(nowMs: number, earliestMs?: number): SpanWindow {
  const rawStart = earliestMs && Number.isFinite(earliestMs) && earliestMs > 0 ? earliestMs : nowMs - 90 * DAY_MS;
  const spanMs = Math.max(nowMs - rawStart, DAY_MS);
  let bucketMs = DAY_MS;
  let buckets = Math.ceil(spanMs / bucketMs);
  if (buckets > 90) {
    bucketMs = Math.max(1, Math.ceil(spanMs / 90 / DAY_MS)) * DAY_MS;
    buckets = Math.ceil(spanMs / bucketMs);
  }
  const startMs = Math.floor(rawStart / bucketMs) * bucketMs;
  return { startMs, endMs: nowMs, bucketMs, buckets };
}
