/**
 * Shared HTTP for usage fetchers. One timeout, one retry policy.
 * Port of `legacy-rust/src/usage/http.rs`:
 *   - `httpJson` is the simple wrapper used by fetchers that don't need retry.
 *   - `sendRetry` re-issues on 429 / 5xx with exponential backoff 500ms*2^n
 *     capped at 5 attempts (per the Phase 4 spec).
 */

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 500;

async function withTimeout(
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<RequestInit> {
  const signal = (init?.signal ?? undefined) as AbortSignal | undefined;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("timeout")), timeoutMs);
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener("abort", () => ctrl.abort(signal.reason), { once: true });
  }
  return { ...(init ?? {}), signal: ctrl.signal };
}

/** GET/POST/etc. with a 20s default timeout. Throws on non-2xx with status+body. */
export async function httpJson(
  url: string,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  const merged = await withTimeout(init, timeoutMs);
  const resp = await fetch(url, merged);
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status} ${resp.statusText} from ${url}: ${body}`);
  }
  return resp.json();
}

/**
 * `sendRetry` re-issues the request on 429 / 5xx (and network errors) with
 * exponential backoff (500ms * 2^attempt, attempt capped at 5). Caps at 5
 * total attempts before returning the last transient response or throwing.
 */
export async function sendRetry(
  url: string,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const merged = await withTimeout(init, timeoutMs);
      const resp = await fetch(url, merged);
      if ((resp.status === 429 || resp.status >= 500) && attempt + 1 < MAX_ATTEMPTS) {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, BASE_BACKOFF_MS * (1 << Math.min(attempt, 5)));
        await promise;
        continue;
      }
      return resp;
    } catch (e) {
      lastErr = e;
      if (attempt + 1 < MAX_ATTEMPTS) {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, BASE_BACKOFF_MS * (1 << Math.min(attempt, 5)));
        await promise;
        continue;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}