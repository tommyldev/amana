//! Generic OAuth primitives shared by provider flows: PKCE, CSRF state, a
//! loopback callback listener, and a JSON token POST. atop runs these itself —
//! it never reuses another tool's tokens.
use anyhow::{anyhow, Result};
use base64::Engine;
use std::collections::HashMap;

pub mod anthropic;
pub mod callback;
pub mod google;

pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

/// RFC 7636 PKCE pair: 96-byte verifier (base64url), S256 challenge.
pub fn pkce() -> Result<Pkce> {
    let mut verifier_bytes = [0u8; 96];
    getrandom::getrandom(&mut verifier_bytes).map_err(|e| anyhow!("rng: {e}"))?;
    let verifier = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(verifier_bytes);
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(hasher.finalize());
    Ok(Pkce { verifier, challenge })
}

/// 16-byte CSRF state token, lowercase hex.
pub fn random_state() -> Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|e| anyhow!("rng: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Parse a pasted redirect URL / query string / raw `code#state` into (code, state).
/// Mirrors oh-my-pi's `parseCallbackInput`.
pub fn parse_callback_input(input: &str) -> (Option<String>, Option<String>) {
    let value = input.trim();
    if value.is_empty() {
        return (None, None);
    }
    if let Some(q) = value.split_once('?').map(|(_, q)| q) {
        let params = parse_query(q.split('#').next().unwrap_or(q));
        if params.contains_key("code") {
            return (params.get("code").cloned(), params.get("state").cloned());
        }
    }
    if value.contains("code=") {
        let trimmed = value.trim_start_matches(['?', '#']);
        let params = parse_query(trimmed);
        return (params.get("code").cloned(), params.get("state").cloned());
    }
    let mut it = value.splitn(2, '#');
    let code = it.next().map(|s| s.to_string());
    let state = it.next().map(|s| s.to_string()).filter(|s| !s.is_empty());
    (code, state)
}

/// Parse an `a=b&c=d` query string with percent-decoding.
pub fn parse_query(q: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for pair in q.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        out.insert(percent_decode(k), percent_decode(v));
    }
    out
}

/// Minimal percent-decoder (`%XX` and `+` → space) for OAuth callback params.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                if let (Some(h), Some(l)) = (hi, lo) {
                    out.push((h * 16 + l) as u8);
                    i += 3;
                    continue;
                }
                out.push(b'%');
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// POST a JSON body and return the response body text, erroring on non-2xx.
pub async fn post_json(
    client: &reqwest::Client,
    url: &str,
    body: &serde_json::Value,
) -> Result<String> {
    let resp = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .json(body)
        .send()
        .await?;
    let status = resp.status();
    let text = resp.text().await?;
    if !status.is_success() {
        return Err(anyhow!("HTTP {status} from {url}: {text}"));
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_is_sha256_of_verifier() {
        let p = pkce().unwrap();
        // Recompute the challenge from the verifier; must match.
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(p.verifier.as_bytes());
        let expect = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(h.finalize());
        assert_eq!(p.challenge, expect);
        assert!(!p.verifier.contains('='), "base64url is unpadded");
    }

    #[test]
    fn state_is_32_hex_chars() {
        let s = random_state().unwrap();
        assert_eq!(s.len(), 32);
        assert!(s.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn parse_callback_handles_url_query_and_raw() {
        let (c, s) = parse_callback_input("http://localhost:54545/callback?code=abc&state=xyz");
        assert_eq!(c.as_deref(), Some("abc"));
        assert_eq!(s.as_deref(), Some("xyz"));
        let (c2, s2) = parse_callback_input("code=def&state=qrs");
        assert_eq!(c2.as_deref(), Some("def"));
        assert_eq!(s2.as_deref(), Some("qrs"));
        let (c3, s3) = parse_callback_input("rawcode#rawstate");
        assert_eq!(c3.as_deref(), Some("rawcode"));
        assert_eq!(s3.as_deref(), Some("rawstate"));
    }

    #[test]
    fn percent_decode_basics() {
        assert_eq!(percent_decode("a%2Bb%20c"), "a+b c");
    }
}
