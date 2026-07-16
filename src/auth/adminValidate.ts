/**
 * Validate an admin (org-level) key by hitting the provider's cheapest
 * authenticated endpoint. Used by `atop login openai-api` /
 * `atop login anthropic-api`; on success the key is stored and the provider
 * is enabled in config.
 *
 * Port of `legacy-rust/src/cli/validate.rs`: 15s timeout, exact endpoints,
 * exact headers/body. Throws `admin key validation failed: <status>` on any
 * non-2xx response.
 */
import type { SourceKind } from "../registry.ts";

const TIMEOUT_MS = 15_000;

async function probe(url: string, init: RequestInit): Promise<Response> {
  return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

function badStatus(status: number, body: string): never {
  const snippet = body.length > 200 ? `${body.slice(0, 200)}…` : body;
  throw new Error(`admin key validation failed: ${status} ${snippet}`);
}

export async function validateAdminKey(kind: SourceKind, key: string): Promise<void> {
  if (kind === "LogOmp" || kind === "LogClaudeCode") return;
  if (kind === "AdminOpenAI") {
    const resp = await probe("https://api.openai.com/v1/models", {
      headers: { authorization: `Bearer ${key}` },
    });
    if (!resp.ok) badStatus(resp.status, await resp.text());
    return;
  }
  if (kind === "AdminAnthropic") {
    const resp = await probe("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-3-5-haiku-latest",
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    if (!resp.ok) badStatus(resp.status, await resp.text());
    return;
  }
}
