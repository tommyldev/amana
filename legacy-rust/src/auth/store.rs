//! Persistence for atop credentials: one JSON array of {@link Credential} per
//! provider id, kept in the `secrets` table of `atop.db` (AES-256-GCM).
use anyhow::Result;

use super::Credential;
use crate::db::Db;

pub fn load(db: &Db, provider: &str) -> Result<Vec<Credential>> {
    match db.get_secret(provider)? {
        Some(s) if !s.trim().is_empty() => Ok(serde_json::from_str(&s).unwrap_or_default()),
        _ => Ok(Vec::new()),
    }
}

pub fn save(db: &Db, provider: &str, creds: &[Credential]) -> Result<()> {
    if creds.is_empty() {
        return db.delete_secret(provider);
    }
    db.set_secret(provider, &serde_json::to_string(creds)?)
}

/// Pure dedup: insert `cred`, replacing any existing credential with the same
/// identity (or the lone identity-less credential for single-account providers).
pub(crate) fn merge(creds: &mut Vec<Credential>, cred: Credential) {
    match cred.identity() {
        Some(id) => {
            if let Some(slot) = creds.iter_mut().find(|c| c.identity().as_deref() == Some(id.as_str())) {
                *slot = cred;
            } else {
                creds.push(cred);
            }
        }
        None => {
            if let Some(slot) = creds.iter_mut().find(|c| c.identity().is_none()) {
                *slot = cred;
            } else {
                creds.push(cred);
            }
        }
    }
}

/// Insert `cred` into the provider's stored credentials, then persist.
pub fn upsert(db: &Db, provider: &str, cred: Credential) -> Result<()> {
    let mut creds = load(db, provider)?;
    merge(&mut creds, cred);
    save(db, provider, &creds)
}

/// Providers that currently have stored credentials in atop's secret store.
pub fn all_providers(db: &Db) -> anyhow::Result<Vec<&'static str>> {
    let mut out = Vec::new();
    for p in crate::usage::supported() {
        if !load(db, p)?.is_empty() {
            out.push(*p);
        }
    }
    Ok(out)
}

pub fn remove(db: &Db, provider: &str) -> Result<()> {
    db.delete_secret(provider)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::{ApiKeyCred, OAuthCred};

    fn api(key: &str) -> Credential {
        Credential::ApiKey(ApiKeyCred { key: key.into(), account: None, enterprise_url: None })
    }
    fn oauth(email: &str) -> Credential {
        Credential::Oauth(OAuthCred {
            access: "a".into(),
            refresh: Some("r".into()),
            expires: Some(0),
            account_id: None,
            email: Some(email.into()),
            project_id: None,
            enterprise_url: None,
        })
    }

    #[test]
    fn merge_dedupes_identityless_and_keeps_distinct_identities() {
        let mut creds: Vec<Credential> = Vec::new();
        merge(&mut creds, api("k1"));
        merge(&mut creds, api("k2"));
        assert_eq!(creds.len(), 1, "identity-less api keys collapse to one");
        match &creds[0] {
            Credential::ApiKey(c) => assert_eq!(c.key, "k2"),
            _ => panic!("expected api key"),
        }

        let mut accts: Vec<Credential> = Vec::new();
        merge(&mut accts, oauth("a@x.com"));
        merge(&mut accts, oauth("b@x.com"));
        merge(&mut accts, oauth("a@x.com"));
        assert_eq!(accts.len(), 2, "two distinct emails kept; duplicate replaced");
    }

    #[test]
    fn json_roundtrip_preserves_kind() {
        let creds = vec![api("k1"), oauth("a@x.com")];
        let s = serde_json::to_string(&creds).unwrap();
        let back: Vec<Credential> = serde_json::from_str(&s).unwrap();
        assert!(matches!(back[0], Credential::ApiKey(_)));
        assert!(matches!(back[1], Credential::Oauth(_)));
    }
}
