//! atop's secret store. Credentials (API keys, OAuth tokens) are encrypted
//! with AES-256-GCM and persisted in the `secrets` table of `atop.db`. The
//! data-encryption key (DEK) is a 32-byte random key generated on first use
//! and stored in the OS secret service via the `keyring` crate. The
//! `ATOP_MASTER_KEY` env var (base64, 32 bytes) overrides the keyring for
//! headless environments (CI, servers with no Secret Service) and is the
//! recommended way to run atop on a build machine.
//!
//! Platform note: the `keyring` crate's Linux backend is feature-gated.
//! `Cargo.toml` enables the `sync-secret-service` feature so KWallet (KDE)
//! and GNOME Keyring are reachable over D-Bus. The keyring write is the
//! only platform-conditional operation in this module; if it fails we
//! return an error instead of silently dropping the write (the original
//! bug we replaced).
use anyhow::{anyhow, Context, Result};
use aes_gcm::aead::Aead;
use base64::Engine;
use rusqlite::{params, OptionalExtension};

use super::Db;

const KEY_ID: &str = "atop.master-key.v1";
const NONCE_LEN: usize = 12;

/// 32-byte data-encryption key. Generated once per install and stored in
/// the OS keyring (or `ATOP_MASTER_KEY`).
type Dek = [u8; 32];

thread_local! {
    /// Per-thread DEK override for tests. When set, `load_dek` returns this
    /// key instead of consulting the env or keyring. Production code never
    /// sets this.
    static TEST_DEK: std::cell::RefCell<Option<[u8; 32]>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(crate) fn set_test_dek(key: Option<[u8; 32]>) {
    TEST_DEK.with(|k| *k.borrow_mut() = key);
}

fn load_dek() -> Result<Dek> {
    if let Some(k) = TEST_DEK.with(|k| *k.borrow()) {
        return Ok(k);
    }
    if let Ok(env_key) = std::env::var("ATOP_MASTER_KEY") {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(env_key.trim())
            .context("ATOP_MASTER_KEY is not valid base64")?;
        let key: [u8; 32] = bytes
            .as_slice()
            .try_into()
            .map_err(|_| anyhow!("ATOP_MASTER_KEY must decode to 32 bytes"))?;
        return Ok(key);
    }
    let entry = keyring::Entry::new("atop", KEY_ID).context("open keyring entry")?;
    match entry.get_password() {
        Ok(b64) => {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(b64.trim())
                .context("stored master key is not valid base64")?;
            bytes
                .as_slice()
                .try_into()
                .map_err(|_| anyhow!("stored master key must be 32 bytes"))
        }
        Err(keyring::Error::NoEntry) => {
            let mut key = [0u8; 32];
            getrandom::getrandom(&mut key).map_err(|e| anyhow!("rng: {e}"))?;
            let b64 = base64::engine::general_purpose::STANDARD.encode(key);
            entry
                .set_password(&b64)
                .map_err(|e| {
                    anyhow!(
                        "could not persist master key in OS keyring ({e}); \
                         set ATOP_MASTER_KEY to a base64 32-byte key instead"
                    )
                })?;
            Ok(key)
        }
        Err(e) => Err(anyhow!("keyring read failed: {e}")),
    }
}

fn cipher() -> Result<aes_gcm::Aes256Gcm> {
    use aes_gcm::KeyInit;
    let key = load_dek()?;
    Ok(aes_gcm::Aes256Gcm::new(&key.into()))
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn random_nonce() -> Result<[u8; NONCE_LEN]> {
    let mut n = [0u8; NONCE_LEN];
    getrandom::getrandom(&mut n).map_err(|e| anyhow!("rng: {e}"))?;
    Ok(n)
}

pub fn get(db: &Db, id: &str) -> Result<Option<String>> {
    let row: Option<(Vec<u8>, Vec<u8>)> = db.conn.lock().query_row(
        "SELECT nonce, ciphertext FROM secrets WHERE id = ?",
        params![id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ).optional()?;
    let Some((nonce, ct)) = row else { return Ok(None) };
    if nonce.len() != NONCE_LEN {
        return Err(anyhow!(
            "secret {id}: nonce length {} (expected {NONCE_LEN}); \
             the on-disk schema changed — re-login required",
            nonce.len()
        ));
    }
    let cipher = cipher()?;
    let pt = cipher
        .decrypt(nonce.as_slice().into(), ct.as_ref())
        .map_err(|e| anyhow!("decrypt {id}: {e}; re-login required"))?;
    Ok(Some(String::from_utf8(pt).map_err(|_| anyhow!("secret {id}: non-utf8 plaintext"))?))
}

pub fn set(db: &Db, id: &str, value: &str) -> Result<()> {
    let cipher = cipher()?;
    let nonce = random_nonce()?;
    let ct = cipher
        .encrypt(nonce.as_slice().into(), value.as_bytes())
        .map_err(|e| anyhow!("encrypt {id}: {e}"))?;
    let now = now_ms();
    db.conn.lock().execute(
        "INSERT INTO secrets(id, nonce, ciphertext, updated_at_ms) \
         VALUES(?1, ?2, ?3, ?4) \
         ON CONFLICT(id) DO UPDATE SET \
           nonce=excluded.nonce, \
           ciphertext=excluded.ciphertext, \
           updated_at_ms=excluded.updated_at_ms",
        params![id, nonce.as_slice(), ct, now],
    ).context("write secret")?;
    Ok(())
}

pub fn delete(db: &Db, id: &str) -> Result<()> {
    db.conn.lock().execute(
        "DELETE FROM secrets WHERE id = ?",
        params![id],
    )?;
    Ok(())
}

pub fn list_ids(db: &Db) -> Result<Vec<String>> {
    let conn = db.conn.lock();
    let mut stmt = conn.prepare("SELECT id FROM secrets ORDER BY id")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    fn temp_db() -> (tempfile::TempDir, Db) {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("atop.db")).unwrap();
        // Use a unique per-test key in the thread-local override so parallel
        // tests don't race on ATOP_MASTER_KEY. Each test runs in its own
        // thread; thread-locals are not shared.
        let mut key = [0u8; 32];
        getrandom::getrandom(&mut key).unwrap();
        set_test_dek(Some(key));
        (tmp, db)
    }

    #[test]
    fn roundtrip_get_set_delete() {
        let (_tmp, db) = temp_db();
        assert!(get(&db, "anthropic").unwrap().is_none());
        set(&db, "anthropic", "sk-test-12345").unwrap();
        assert_eq!(get(&db, "anthropic").unwrap().as_deref(), Some("sk-test-12345"));
        delete(&db, "anthropic").unwrap();
        assert!(get(&db, "anthropic").unwrap().is_none());
    }

    #[test]
    fn set_overwrites_existing() {
        let (_tmp, db) = temp_db();
        set(&db, "zai", "v1").unwrap();
        set(&db, "zai", "v2").unwrap();
        assert_eq!(get(&db, "zai").unwrap().as_deref(), Some("v2"));
    }

    #[test]
    fn ciphertext_on_disk_is_not_plaintext() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("atop.db");
        {
            let db = Db::open(&path).unwrap();
            let mut key = [0u8; 32];
            getrandom::getrandom(&mut key).unwrap();
            set_test_dek(Some(key));
            set(&db, "anthropic", "sk-very-secret").unwrap();
        }
        let raw = std::fs::read(&path).unwrap();
        let haystack = String::from_utf8_lossy(&raw);
        assert!(!haystack.contains("sk-very-secret"), "plaintext leaked to disk");
        assert!(!haystack.contains("very-secret"), "secret substring leaked");
    }

    #[test]
    fn wrong_master_key_fails_loudly() {
        let (_tmp, db) = temp_db();
        set(&db, "anthropic", "sk-test").unwrap();
        let mut other = [0u8; 32];
        getrandom::getrandom(&mut other).unwrap();
        set_test_dek(Some(other));
        let err = get(&db, "anthropic").unwrap_err().to_string();
        assert!(err.contains("re-login"), "expected re-login hint, got: {err}");
    }

    #[test]
    fn list_ids_returns_seeded_rows() {
        let (_tmp, db) = temp_db();
        set(&db, "anthropic", "a").unwrap();
        set(&db, "zai", "b").unwrap();
        let mut ids = list_ids(&db).unwrap();
        ids.sort();
        assert_eq!(ids, vec!["anthropic".to_string(), "zai".to_string()]);
    }
}
