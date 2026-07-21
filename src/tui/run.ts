import React from "react";
import { render } from "ink";
import { createInterface } from "node:readline";
import { cliContext } from "../cli/context.ts";
import { App } from "./App.tsx";
import { performLogin, type LoginRequest } from "./login/perform.ts";
import type { LoginCtx } from "../auth/loginFlows.ts";

const ENTER_ALT_SCREEN = "\x1b[?1049h";
const LEAVE_ALT_SCREEN = "\x1b[?1049l";

/** Block until the user presses Enter (used after an interactive login prints
 *  its result in the normal terminal, before re-entering the dashboard). */
function waitForEnter(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.question("", () => {
    rl.close();
    resolve();
  });
  return promise;
}
/**
 * Launch the live TUI dashboard as a full-screen alternate-screen panel. When
 * the user starts a provider login (`p` → pick a method), the dashboard exits,
 * we drop back to the normal screen to run the interactive/browser login flow
 * (reusing the CLI flows verbatim), then re-enter and reopen that provider so
 * multiple OAuth accounts / API keys can be added in sequence. Invoked by
 * `amana` with no subcommand.
 */
export async function run(): Promise<void> {
  const { db, cfg, dataDir, paths } = cliContext();
  const loginCtx: LoginCtx = { db, dataDir, cfg, configFile: paths.configFile };
  const leaveAlt = () => process.stdout.write(LEAVE_ALT_SCREEN);
  process.on("exit", leaveAlt);
  let reopen: string | undefined;
  try {
    for (;;) {
      let pending: LoginRequest | null = null;
      process.stdout.write(ENTER_ALT_SCREEN);
      const instance = render(
        React.createElement(App, {
          db,
          cfg,
          dataDir,
          configFile: paths.configFile,
          reopenProvider: reopen,
          onLogin: (req: LoginRequest) => {
            pending = req;
          },
        }),
        { exitOnCtrlC: true },
      );
      await instance.waitUntilExit();
      leaveAlt();
      if (pending === null) break;
      const req: LoginRequest = pending;
      const result = await performLogin(loginCtx, req);
      process.stdout.write(`\n${result.message}\n\nPress Enter to return to amana…`);
      await waitForEnter();
      reopen = req.providerId;
    }
  } finally {
    process.off("exit", leaveAlt);
    leaveAlt();
    db.close();
  }
}
