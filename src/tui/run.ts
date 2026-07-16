import React from "react";
import { render } from "ink";
import { cliContext } from "../cli/context.ts";
import { App } from "./App.tsx";

const ENTER_ALT_SCREEN = "\x1b[?1049h";
const LEAVE_ALT_SCREEN = "\x1b[?1049l";

/**
 * Launch the live TUI dashboard as a full-screen panel. Switches to the
 * terminal's alternate screen buffer (like vim/htop and modern agent
 * harnesses) so the dashboard owns the whole screen and the previous
 * scrollback is restored untouched on exit. Invoked by `atop` with no
 * subcommand.
 */
export async function run(): Promise<void> {
  const { db, cfg, dataDir } = cliContext();
  process.stdout.write(ENTER_ALT_SCREEN);
  const restore = () => process.stdout.write(LEAVE_ALT_SCREEN);
  process.on("exit", restore);
  try {
    const instance = render(React.createElement(App, { db, cfg, dataDir }), { exitOnCtrlC: true });
    await instance.waitUntilExit();
  } finally {
    process.off("exit", restore);
    restore();
    db.close();
  }
}
