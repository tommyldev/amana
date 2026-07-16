import type { Database } from "bun:sqlite";

export function setProviderStatus(db: Database, id: string, status: string): void {
  db.query(
    `INSERT INTO providers(id,label,source_kind,enabled,status) VALUES (?,?,?,1,?)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status`,
  ).run(id, id, "unknown", status);
}

export function ensureProvider(db: Database, id: string, label: string, sourceKind: string): void {
  db.query(
    `INSERT OR IGNORE INTO providers(id,label,source_kind,enabled,status) VALUES (?,?,?,1,'ok')`,
  ).run(id, label, sourceKind);
}

export function providerStatus(db: Database, id: string): string | null {
  const row = db.query("SELECT status FROM providers WHERE id = ?").get(id) as
    | { status: string }
    | null;
  return row ? row.status : null;
}
