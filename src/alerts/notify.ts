import { spawn } from "node:child_process";

/**
 * Desktop notification shim — zero native deps.
 * - Linux: `notify-send -u critical <summary> <body>`
 * - macOS: `osascript -e 'display notification "<body>" with title "<summary>"'`
 * - Windows: no-op (this app does not target Windows desktop notifications).
 *
 * Spawn failures are logged to stderr and swallowed — alerting must never
 * throw, because `engine.checkAndFire` calls this per fired event and an
 * exception there would abort the TUI refresh loop.
 */
export function notify(summary: string, body: string): void {
  try {
    if (process.platform === "linux") {
      const proc = spawn(
        "notify-send",
        ["-u", "critical", summary, body],
        { stdio: "ignore", detached: true },
      );
      proc.on("error", (err) => {
        process.stderr.write(`atop: notify-send failed: ${err.message}\n`);
      });
      proc.unref();
      return;
    }

    if (process.platform === "darwin") {
      // osascript expects a single -e expression; embed both args safely:
      // wrap each in double quotes, escape any embedded double-quotes/backslashes.
      const script = `display notification ${quote(body)} with title ${quote(summary)}`;
      const proc = spawn("osascript", ["-e", script], { stdio: "ignore", detached: true });
      proc.on("error", (err) => {
        process.stderr.write(`atop: osascript failed: ${err.message}\n`);
      });
      proc.unref();
      return;
    }

    // Windows: no-op. Spec says skip; we don't shell out to msg.exe.
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`atop: notify spawn threw: ${msg}\n`);
  }
}

/** AppleScript-style double-quoted string with `\` and `"` escaped. */
function quote(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}