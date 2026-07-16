//! Tests for the orchestrator: error collection across per-credential fetches
//! and the `FetchError` Display impl.
#[cfg(test)]
mod tests {
    use super::super::orchestrator::FetchError;

    #[test]
    fn fetch_error_displays_provider_account_and_message() {
        let e = FetchError {
            provider: "zai".into(),
            account: "primary".into(),
            message: "HTTP 401 from https://api.z.ai/api/monitor/usage/quota/limit".into(),
        };
        assert_eq!(
            e.to_string(),
            "zai (primary): HTTP 401 from https://api.z.ai/api/monitor/usage/quota/limit",
        );
    }

    #[test]
    fn fetch_error_holds_all_three_fields_independently() {
        let e = FetchError {
            provider: "anthropic".into(),
            account: "tommy@basedaf.dev".into(),
            message: "invalid_token".into(),
        };
        assert_eq!(e.provider, "anthropic");
        assert_eq!(e.account, "tommy@basedaf.dev");
        assert_eq!(e.message, "invalid_token");
    }
}
