import React from "react";
import { render } from "ink";
import { cliContext } from "../cli/context.ts";
import { App } from "./App.tsx";

/** Launch the live TUI dashboard. Invoked by `atop` with no subcommand. */
export async function run(): Promise<void> {
  const { db, cfg, dataDir } = cliContext();
  const instance = render(React.createElement(App, { db, cfg, dataDir }), { exitOnCtrlC: true });
  await instance.waitUntilExit();
  db.close();
}
