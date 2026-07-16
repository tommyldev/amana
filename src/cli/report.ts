/**
 * `atop report` — run an incremental sync, then render today's spend plus a
 * per-provider window-status line. Port of `cli/mod.rs` Cmd::Report arm.
 */
import { cliContext } from "./context.ts";
import { runSync } from "../ingest/sync.ts";
import { renderReport } from "../report/report.ts";

export async function run(argv: string[]): Promise<void> {
  // No positional/options yet — kept for shape parity with sibling CLIs.
  void argv;
  const { db, cfg, dataDir } = cliContext();
  await runSync(db, cfg, dataDir, false);
  process.stdout.write(renderReport(db, cfg, Date.now()));
}
