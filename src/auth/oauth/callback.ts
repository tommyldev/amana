/**
 * Loopback OAuth callback listener. Opens the browser to the provider's
 * authorize URL, waits for the redirect to `127.0.0.1:<port><path>`, validates
 * state, and returns `(code, state)`. Falls back to a paste prompt when the
 * port can't be bound.
 *
 * Port of `auth/oauth/callback.rs`.
 */
import { spawn } from "node:child_process";
import { parseQuery } from "./pkce.ts";
import type { LoginUi } from "./ui.ts";

export interface CallbackResult {
  code: string;
  state: string;
}

const SUCCESS_HTML =
  "<!doctype html><meta charset=utf-8><title>Agent Mana</title>" +
  "<body style=\"font:14px system-ui;padding:2rem\">" +
  "<h2>Agent Mana: authentication complete</h2>" +
  "<p>You can close this tab and return to the terminal.</p></body>";

const FAILURE_HTML =
  "<!doctype html><meta charset=utf-8><title>Agent Mana</title>" +
  "<body style=\"font:14px system-ui;padding:2rem\">" +
  "<h2>Agent Mana: authentication failed</h2>" +
  "<p>Check the terminal for details.</p></body>";

interface LoopbackServer {
  stop(close?: boolean): void;
}

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Run the redirect leg: open the browser, listen on the loopback (both IPv4 and
 * IPv6 families), AND concurrently accept a pasted authorization code / redirect
 * URL from the terminal — whichever arrives first wins. The paste path is not
 * just a port-busy fallback: some providers (e.g. Anthropic's `code=true` flow)
 * display the code on a page instead of redirecting to the loopback, so the user
 * must paste it. Rejects after a 5-minute timeout instead of hanging.
 */
export async function loopbackCallback(
  port: number,
  path: string,
  expectedState: string,
  authUrl: string,
  ui: LoginUi,
): Promise<CallbackResult> {
  const { promise, resolve, reject } = Promise.withResolvers<CallbackResult>();
  const servers = startLoopback(port, path, expectedState, resolve, reject);
  ui.prompt({ url: authUrl, needsPaste: true });

  // Race the loopback redirect against a pasted code/url. The AbortSignal lets
  // us tear down the losing paste path (close its readline / clear the TUI
  // field) once a winner emerges. A paste rejection (e.g. user cancel) rejects
  // the whole login; resolve/reject are no-ops once settled.
  const ac = new AbortController();
  void ui.paste(ac.signal).then(
    (r) => {
      if (expectedState && r.state && r.state !== expectedState) {
        reject(new Error("state mismatch (possible CSRF)"));
        return;
      }
      resolve({ code: r.code, state: r.state ?? "" });
    },
    (err: unknown) => reject(err instanceof Error ? err : new Error(String(err))),
  );

  const timer = setTimeout(() => {
    reject(new Error("timed out waiting for authorization (5 min) — try again"));
    ac.abort();
  }, CALLBACK_TIMEOUT_MS);

  try {
    return await promise;
  } finally {
    clearTimeout(timer);
    ac.abort();
    for (const s of servers) s.stop();
  }
}

/** Open a URL in the user's default browser. Errors are swallowed. */
export function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
    child.unref();
  } catch {
    // swallow — we'll still print the URL
  }
}

/**
 * Bind the loopback callback on both IPv4 (`127.0.0.1`) and IPv6 (`::1`) so the
 * redirect reaches us regardless of how `localhost` resolves. Returns the bound
 * servers (empty when the port is unavailable on both families — the caller then
 * relies on the concurrent paste path).
 */
function startLoopback(
  port: number,
  path: string,
  expectedState: string,
  resolve: (r: CallbackResult) => void,
  reject: (e: Error) => void,
): LoopbackServer[] {
  const handler = (req: Request): Response => {
    try {
      const url = new URL(req.url);
      if (url.pathname !== path) return new Response("not found", { status: 404 });
      const result = interpret(parseQuery(url.search.replace(/^\?/, "")), expectedState);
      // Defer signalling completion until AFTER this Response is handed back to
      // Bun, so the browser receives the success/failure page before the server
      // is torn down (a synchronous resolve + graceful stop can still race the
      // socket flush).
      if (result.ok) queueMicrotask(() => resolve(result.value));
      else queueMicrotask(() => reject(result.error));
      return new Response(result.ok ? SUCCESS_HTML : FAILURE_HTML, {
        status: result.ok ? 200 : 400,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    } catch (e) {
      reject(e as Error);
      return new Response(FAILURE_HTML, { status: 500, headers: { "content-type": "text/html; charset=utf-8" } });
    }
  };
  const servers: LoopbackServer[] = [];
  for (const hostname of ["127.0.0.1", "::1"]) {
    try {
      servers.push(Bun.serve({ port, hostname, fetch: handler }));
    } catch {
      // Family unavailable (no IPv6) or already bound — fine if the other binds.
    }
  }
  return servers;
}

type InterpretResult =
  | { ok: true; value: CallbackResult }
  | { ok: false; error: Error };

function interpret(params: Map<string, string>, expectedState: string): InterpretResult {
  const errCode = params.get("error");
  if (errCode) {
    const desc = params.get("error_description") ?? errCode;
    return { ok: false, error: new Error(`authorization failed: ${desc}`) };
  }
  const code = params.get("code");
  if (!code) return { ok: false, error: new Error("missing authorization code") };
  const state = params.get("state") ?? "";
  if (expectedState && state && state !== expectedState) {
    return { ok: false, error: new Error("state mismatch (possible CSRF)") };
  }
  return { ok: true, value: { code, state } };
}