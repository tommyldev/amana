/**
 * `amana sync` — ingest every enabled provider's source now. `--full` resets
 * the byte offsets to 0 so JSONL files are re-read from the top. Port of
 * `cli/mod.rs` Cmd::Sync arm.
 */
import { parseArgs } from "node:util";
import { cliContext } from "./context.ts";
import { runSync } from "../ingest/sync.ts";

export async function run(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      full: { type: "boolean" },
    },
    allowPositionals: true,
    strict: false,
  });
  const { db, cfg, dataDir } = cliContext();
  const counts = await runSync(db, cfg, dataDir, !!values.full);
  for (const c of counts) {
    console.log(`${c.source}: inserted ${c.inserted}`);
  }
}
