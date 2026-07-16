import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export interface Paths {
  configDir: string;
  dataDir: string;
  configFile: string;
  dbFile: string;
}

/**
 * Resolve atop's filesystem locations. `ATOP_CONFIG_DIR` / `ATOP_DATA_DIR`
 * override the XDG-derived defaults and are the mechanism tests use to stay
 * hermetic. Both directories are created if missing.
 */
export function resolvePaths(): Paths {
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const xdgData = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  const configDir = process.env.ATOP_CONFIG_DIR ?? join(xdgConfig, "atop");
  const dataDir = process.env.ATOP_DATA_DIR ?? join(xdgData, "atop");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  return {
    configDir,
    dataDir,
    configFile: join(configDir, "config.toml"),
    dbFile: join(dataDir, "atop.db"),
  };
}

/** Root for oh-my-pi session logs consumed by the omp ingestion source. */
export function ompDir(): string {
  return process.env.ATOP_OMP_DIR ?? join(homedir(), ".omp", "agent", "sessions");
}

/** Root for Claude Code project logs consumed by the claude-code source. */
export function claudeDir(): string {
  return process.env.ATOP_CLAUDE_DIR ?? join(homedir(), ".claude", "projects");
}

/** Path to the plain-file credential store (mode 0600). */
export function credentialsFile(dataDir: string): string {
  return join(dataDir, "credentials.json");
}
