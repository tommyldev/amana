use anyhow::Result;
use rusqlite::{params, OptionalExtension};

pub fn set_sync(db: &super::Db, source: &str, path: &str, offset: i64, mtime_ms: i64) -> Result<()> {
    db.conn.lock().execute(
        "INSERT INTO sync_state(source,path,offset,mtime_ms) VALUES (?,?,?,?)
         ON CONFLICT(source,path) DO UPDATE SET offset=excluded.offset, mtime_ms=excluded.mtime_ms",
        params![source, path, offset, mtime_ms],
    )?;
    Ok(())
}

pub fn get_sync(db: &super::Db, source: &str, path: &str) -> Result<Option<(i64, i64)>> {
    let row: Option<(i64, i64)> = db.conn.lock().query_row(
        "SELECT offset, mtime_ms FROM sync_state WHERE source = ? AND path = ?",
        params![source, path],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ).optional()?;
    Ok(row)
}
