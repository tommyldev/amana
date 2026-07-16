import type { Database } from "bun:sqlite";

export interface SyncCursor {
  offset: number;
  mtime_ms: number;
}

export function setSync(db: Database, source: string, path: string, offset: number, mtimeMs: number): void {
  db.query(
    `INSERT INTO sync_state(source,path,offset,mtime_ms) VALUES (?,?,?,?)
     ON CONFLICT(source,path) DO UPDATE SET offset=excluded.offset, mtime_ms=excluded.mtime_ms`,
  ).run(source, path, offset, mtimeMs);
}

export function getSync(db: Database, source: string, path: string): SyncCursor | null {
  return db
    .query("SELECT offset, mtime_ms FROM sync_state WHERE source = ? AND path = ?")
    .get(source, path) as SyncCursor | null;
}
