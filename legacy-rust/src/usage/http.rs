//! Shared HTTP for usage fetchers: one reqwest client + a small retry wrapper
//! that re-issues on 429 / 5xx with exponential backoff.
use std::time::Duration;

pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Send the request built by `build`, retrying up to `attempts` times on
/// transient failures (network error, HTTP 429, or 5xx). `build` is called
/// fresh per attempt so no request-body cloning is needed.
pub async fn send_retry(
    build: impl Fn() -> reqwest::RequestBuilder,
    attempts: usize,
) -> reqwest::Result<reqwest::Response> {
    let attempts = attempts.max(1);
    let mut last: Option<reqwest::Error> = None;
    for attempt in 0..attempts {
        match build().send().await {
            Ok(resp) => {
                let s = resp.status();
                let transient = s.as_u16() == 429 || s.is_server_error();
                if transient && attempt + 1 < attempts {
                    backoff(attempt).await;
                    continue;
                }
                return Ok(resp);
            }
            Err(e) => {
                last = Some(e);
                if attempt + 1 < attempts {
                    backoff(attempt).await;
                    continue;
                }
            }
        }
    }
    Err(last.expect("loop ran at least once and either returned or set last"))
}

async fn backoff(attempt: usize) {
    let ms = 500u64.saturating_mul(1u64 << attempt.min(5));
    tokio::time::sleep(Duration::from_millis(ms)).await;
}
