import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage_events(
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  timestamp_ms INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL,
  cost_usd REAL,
  cost_origin TEXT NOT NULL,
  UNIQUE(source, source_message_id) ON CONFLICT IGNORE);
CREATE TABLE IF NOT EXISTS providers(
  id TEXT PRIMARY KEY, label TEXT NOT NULL, source_kind TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'ok');
CREATE TABLE IF NOT EXISTS sync_state(
  source TEXT NOT NULL, path TEXT NOT NULL, offset INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL, PRIMARY KEY(source,path));
CREATE TABLE IF NOT EXISTS alert_state(
  provider TEXT NOT NULL, account TEXT NOT NULL, limit_id TEXT NOT NULL,
  threshold INTEGER NOT NULL, epoch TEXT NOT NULL, fired_at_ms INTEGER NOT NULL,
  PRIMARY KEY(provider, account, limit_id, threshold, epoch));
CREATE TABLE IF NOT EXISTS usage_snapshots(
  id INTEGER PRIMARY KEY,
  fetched_at_ms INTEGER NOT NULL,
  provider TEXT NOT NULL,
  account TEXT NOT NULL,
  limit_id TEXT NOT NULL,
  used REAL,
  limit_amount REAL,
  unit TEXT NOT NULL,
  resets_at_ms INTEGER);
CREATE INDEX IF NOT EXISTS idx_usage_snapshots_plt
  ON usage_snapshots(provider, limit_id, fetched_at_ms);
`;

/**
 * Open (creating if needed) the atop SQLite database in WAL mode and apply
 * the schema. The legacy Rust `secrets` table is intentionally not recreated;
 * if it exists in an older db it is simply unused.
 */
export function openDb(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

export type { Database };
