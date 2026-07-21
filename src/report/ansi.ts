/**
 * Minimal ANSI color helpers — atop deliberately avoids a chalk dependency.
 * Coloring is gated on an interactive stdout and the absence of NO_COLOR, so
 * piped/redirected output and CI stay plain. `stripAnsi` is exported for tests.
 */
const ENABLED =
  !process.env.NO_COLOR && (process.env.FORCE_COLOR !== undefined ? process.env.FORCE_COLOR !== "0" : process.stdout.isTTY === true);

const RESET = "\x1b[0m";

function paint(open: string, text: string): string {
  return ENABLED ? `${open}${text}${RESET}` : text;
}

export const bold = (t: string): string => paint("\x1b[1m", t);
export const dim = (t: string): string => paint("\x1b[2m", t);
export const red = (t: string): string => paint("\x1b[31m", t);
export const yellow = (t: string): string => paint("\x1b[33m", t);
export const green = (t: string): string => paint("\x1b[32m", t);
export const cyan = (t: string): string => paint("\x1b[36m", t);
export const boldCyan = (t: string): string => paint("\x1b[1;36m", t);

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
