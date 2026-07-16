import type { Database } from "bun:sqlite";
import type { Config } from "../config/types.ts";
import type { Paths } from "../config/paths.ts";
import { resolvePaths } from "../config/paths.ts";
import { loadConfig } from "../config/config.ts";
import { openDb } from "../db/db.ts";

export interface CliContext {
  paths: Paths;
  cfg: Config;
  db: Database;
  dataDir: string;
}

/** Resolve paths, load config, and open the database for a CLI subcommand. */
export function cliContext(): CliContext {
  const paths = resolvePaths();
  const cfg = loadConfig(paths.configFile);
  const db = openDb(paths.dbFile);
  return { paths, cfg, db, dataDir: paths.dataDir };
}
