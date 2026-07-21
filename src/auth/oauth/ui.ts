/**
 * UI surface for interactive OAuth flows. Decouples the flows from the terminal
 * so the same flow code runs either from the CLI (logs + stdin readline, via
 * `cliUi`) or from inside the TUI dashboard (a modal that owns its own input).
 * Every method's default preserves the original CLI behavior byte-for-byte.
 *
 * The three things a flow may need:
 * - `prompt`: show an authorize/verification URL (+ optional user code) and open
 *   the browser. Device flows pass a `userCode`; loopback flows set `needsPaste`.
 * - `paste`: loopback flows, when the browser did not redirect automatically
 *   (e.g. Anthropic's `code=true`). Resolves with a parsed `{code, state}`.
 *   Cancellable via the supplied AbortSignal so the loopback listener can clean
 *   up the losing paste path once the redirect wins.
 * - `promptText`: a single line of input (Google's project-id prompt).
 */
import { createInterface } from "node:readline";
import { openBrowser } from "./callback.ts";
import { parseCallbackInput } from "./pkce.ts";

export interface AuthPrompt {
  /** Authorize/verification URL to open in the browser and show the user. */
  url: string;
  /** Device flows: the short code the user may have to enter at the URL. */
  userCode?: string;
  /** Loopback flows: true when a pasted code/URL might be needed. */
  needsPaste?: boolean;
}

export interface PasteResult {
  code: string;
  state?: string;
}

export interface LoginUi {
  prompt(info: AuthPrompt): void;
  paste(signal: AbortSignal): Promise<PasteResult>;
  promptText?(message: string): Promise<string>;
}

/** CLI default: log to the terminal, open the browser, read pastes/text from stdin. */
export function cliUi(): LoginUi {
  return {
    prompt(info: AuthPrompt): void {
      openBrowser(info.url);
      const codeLine = info.userCode ? `\nEnter code: ${info.userCode}\n` : "";
      console.log(`Authorize amana by visiting:\n  ${info.url}\n${codeLine}`);
      if (info.needsPaste) {
        console.log(
          "Waiting for the browser to redirect back…\n" +
            "If it does NOT return automatically, copy the authorization code (or full redirect URL) " +
            "from the page, paste it here, and press Enter:",
        );
      }
    },
    paste: cliPaste,
    promptText: cliPromptText,
  };
}

function cliPaste(signal: AbortSignal): Promise<PasteResult> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const { promise, resolve, reject } = Promise.withResolvers<PasteResult>();
  const cleanup = (): void => {
    signal.removeEventListener("abort", onAbort);
    rl.off("line", onLine);
    rl.close();
  };
  const onLine = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    const parsed = parseCallbackInput(trimmed);
    if (!parsed.code) {
      process.stdout.write("No authorization code found. Paste the code or the full redirect URL:\n");
      return;
    }
    cleanup();
    resolve({ code: parsed.code, state: parsed.state ?? "" });
  };
  const onAbort = (): void => {
    cleanup();
    reject(new Error("paste cancelled"));
  };
  if (signal.aborted) {
    onAbort();
    return promise;
  }
  signal.addEventListener("abort", onAbort, { once: true });
  rl.on("line", onLine);
  return promise;
}

function cliPromptText(message: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  process.stderr.write(message);
  const { promise, resolve } = Promise.withResolvers<string>();
  rl.once("line", (line) => {
    rl.close();
    resolve(line);
  });
  return promise;
}
