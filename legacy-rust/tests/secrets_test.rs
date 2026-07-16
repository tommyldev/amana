use atop::db::Db;
use base64::Engine;
use std::sync::Mutex;

// Process-wide guard so the four integration tests don't race on
// ATOP_MASTER_KEY. Each test sets the env var inside the mutex; while the
// mutex is held no other test can run.
static ENV_LOCK: Mutex<()> = Mutex::new(());

fn with_key<F: FnOnce(&Db)>(f: F) {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = tempfile::tempdir().unwrap();
    let db = Db::open(&tmp.path().join("atop.db")).unwrap();
    let mut key = [0u8; 32];
    getrandom::getrandom(&mut key).unwrap();
    std::env::set_var(
        "ATOP_MASTER_KEY",
        base64::engine::general_purpose::STANDARD.encode(key),
    );
    f(&db);
}

#[test]
fn roundtrip_via_lib_api() {
    with_key(|db| {
        assert!(db.get_secret("anthropic").unwrap().is_none());
        db.set_secret("anthropic", "sk-test-12345").unwrap();
        assert_eq!(
            db.get_secret("anthropic").unwrap().as_deref(),
            Some("sk-test-12345")
        );
        db.delete_secret("anthropic").unwrap();
        assert!(db.get_secret("anthropic").unwrap().is_none());
    });
}

#[test]
fn set_overwrites_existing_via_lib() {
    with_key(|db| {
        db.set_secret("zai", "v1").unwrap();
        db.set_secret("zai", "v2").unwrap();
        assert_eq!(db.get_secret("zai").unwrap().as_deref(), Some("v2"));
    });
}

#[test]
fn ciphertext_on_disk_is_not_plaintext() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("atop.db");
    let mut key = [0u8; 32];
    getrandom::getrandom(&mut key).unwrap();
    std::env::set_var(
        "ATOP_MASTER_KEY",
        base64::engine::general_purpose::STANDARD.encode(key),
    );
    {
        let db = Db::open(&path).unwrap();
        db.set_secret("anthropic", "sk-very-secret").unwrap();
    }
    let raw = std::fs::read(&path).unwrap();
    let haystack = String::from_utf8_lossy(&raw);
    assert!(!haystack.contains("sk-very-secret"), "plaintext leaked to disk");
    assert!(!haystack.contains("very-secret"), "secret substring leaked");
}

#[test]
fn wrong_master_key_fails_loudly() {
    with_key(|db| {
        db.set_secret("anthropic", "sk-test").unwrap();
    });
    // The above lock is released; now set a *different* key and try to read.
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut other = [0u8; 32];
    getrandom::getrandom(&mut other).unwrap();
    std::env::set_var(
        "ATOP_MASTER_KEY",
        base64::engine::general_purpose::STANDARD.encode(other),
    );
    // Reopen the DB the first test wrote to. Easier: re-use the same path
    // via a fresh Db. We can't reach the original DB from this scope, so
    // just verify the failure path with a separate DB.
    let tmp = tempfile::tempdir().unwrap();
    let db = Db::open(&tmp.path().join("atop.db")).unwrap();
    db.set_secret("anthropic", "sk-test-2").unwrap();
    let mut again = [0u8; 32];
    getrandom::getrandom(&mut again).unwrap();
    std::env::set_var(
        "ATOP_MASTER_KEY",
        base64::engine::general_purpose::STANDARD.encode(again),
    );
    let err = db.get_secret("anthropic").unwrap_err().to_string();
    assert!(err.contains("re-login"), "expected re-login hint, got: {err}");
}
