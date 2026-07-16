/**
 * Loopback OAuth callback listener. Opens the browser to the provider's
 * authorize URL, waits for the redirect to `127.0.0.1:<port><path>`, validates
 * state, and returns `(code, state)`. Falls back to a paste prompt when the
 * port can't be bound.
 *
 * Port of `auth/oauth/callback.rs`.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { parseCallbackInput, parseQuery } from "./pkce.ts";

export interface CallbackResult {
  code: string;
  state: string;
}

const SUCCESS_HTML =
  "<!doctype html><meta charset=utf-8><title>atop</title>" +
  "<body style=\"font:14px system-ui;padding:2rem\">" +
  "<h2>atop: authentication complete</h2>" +
  "<p>You can close this tab and return to the terminal.</p></body>";

const FAILURE_HTML =
  "<!doctype html><meta charset=utf-8><title>atop</title>" +
  "<body style=\"font:14px system-ui;padding:2rem\">" +
  "<h2>atop: authentication failed</h2>" +
  "<p>Check the terminal for details.</p></body>";

class PortBusyError extends Error {
  constructor() {
    super("loopback port busy");
  }
}

interface LoopbackServer {
  stop(close?: boolean): void;
}

/**
 * Run the full redirect leg: open browser, listen on the loopback, validate
 * `state`, return `(code, state)`. On port-in-use, prompt via stdin.
 */
export async function loopbackCallback(
  port: number,
  path: string,
  expectedState: string,
  authUrl: string,
): Promise<CallbackResult> {
  openBrowser(authUrl);
  console.log(`Opening your browser to authorize atop. If it doesn't open, visit:\n  ${authUrl}\n`);
  try {
    return await listenLoopback(port, path, expectedState);
  } catch (err) {
    if (!(err instanceof PortBusyError)) throw err;
    return pasteFallback(expectedState);
  }
}

/** Open a URL in the user's default browser. Errors are swallowed. */
export function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(cmd, [url], {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
  } catch {
    // swallow — we'll still print the URL
  }
}

async function listenLoopback(
  port: number,
  path: string,
  expectedState: string,
): Promise<CallbackResult> {
  const { promise: done, resolve: resolveCallback, reject: rejectCallback } =
    Promise.withResolvers<CallbackResult>();
  let server: LoopbackServer | null = null;
  try {
    server = Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch(req): Response {
        try {
          const url = new URL(req.url);
          if (url.pathname !== path) return new Response("not found", { status: 404 });
          const params = parseQuery(url.search.replace(/^\?/, ""));
          const result = interpret(params, expectedState);
          if (result.ok) resolveCallback(result.value);
          else rejectCallback(result.error);
          return new Response(result.ok ? SUCCESS_HTML : FAILURE_HTML, {
            status: result.ok ? 200 : 400,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        } catch (e) {
          rejectCallback(e as Error);
          return new Response(FAILURE_HTML, {
            status: 500,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
      },
    });
  } catch {
    throw new PortBusyError();
  }
  try {
    return await done;
  } finally {
    server?.stop(true);
  }
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

async function pasteFallback(expectedState: string): Promise<CallbackResult> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  process.stderr.write(
    "Could not bind the local callback port. Paste the full redirect URL (or code) here:\n",
  );
  const line = await new Promise<string>((resolve) => rl.once("line", resolve));
  rl.close();
  const { code, state } = parseCallbackInput(line);
  if (!code) throw new Error("no authorization code found in pasted input");
  const returnedState = state ?? "";
  if (expectedState && returnedState && returnedState !== expectedState) {
    throw new Error("state mismatch (possible CSRF)");
  }
  return { code, state: returnedState };
}