use anyhow::Result;
use rusqlite::{params, OptionalExtension};

pub fn set_provider_status(db: &super::Db, id: &str, status: &str) -> Result<()> {
    db.conn.lock().execute(
        "INSERT INTO providers(id,label,source_kind,enabled,status) VALUES (?,?,?,1,?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status",
        params![id, id, "unknown", status],
    )?;
    Ok(())
}

pub fn ensure_provider(db: &super::Db, id: &str, label: &str, source_kind: &str) -> Result<()> {
    db.conn.lock().execute(
        "INSERT OR IGNORE INTO providers(id,label,source_kind,enabled,status)
         VALUES (?,?,?,1,'ok')",
        params![id, label, source_kind],
    )?;
    Ok(())
}

pub fn provider_status(db: &super::Db, id: &str) -> Result<Option<String>> {
    let s: Option<String> = db.conn.lock().query_row(
        "SELECT status FROM providers WHERE id = ?",
        params![id],
        |r| r.get(0),
    ).optional()?;
    Ok(s)
}
