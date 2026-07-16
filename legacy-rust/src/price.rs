/// Per-million-token prices in USD: (in, out).
/// Order: first match wins, so put more specific patterns first.
const PRICES: &[PriceEntry] = &[
    PriceEntry { pattern: "claude-3-5-sonnet", pin_per_mtok: 3.0, pout_per_mtok: 15.0 },
    PriceEntry { pattern: "claude-sonnet-4",   pin_per_mtok: 3.0, pout_per_mtok: 15.0 },
    PriceEntry { pattern: "claude-opus-4",     pin_per_mtok: 15.0, pout_per_mtok: 75.0 },
    PriceEntry { pattern: "claude-3-opus",     pin_per_mtok: 15.0, pout_per_mtok: 75.0 },
    PriceEntry { pattern: "claude-haiku-4",    pin_per_mtok: 1.0, pout_per_mtok: 5.0 },
    PriceEntry { pattern: "claude-3-5-haiku",  pin_per_mtok: 0.80, pout_per_mtok: 4.0 },
    PriceEntry { pattern: "claude-3-haiku",    pin_per_mtok: 0.25, pout_per_mtok: 1.25 },
    PriceEntry { pattern: "gpt-4o",            pin_per_mtok: 2.50, pout_per_mtok: 10.0 },
    PriceEntry { pattern: "gpt-4-turbo",       pin_per_mtok: 10.0, pout_per_mtok: 30.0 },
    PriceEntry { pattern: "gpt-4",             pin_per_mtok: 30.0, pout_per_mtok: 60.0 },
    PriceEntry { pattern: "gpt-3.5-turbo",     pin_per_mtok: 0.50, pout_per_mtok: 1.50 },
    PriceEntry { pattern: "o1",                pin_per_mtok: 15.0, pout_per_mtok: 60.0 },
    PriceEntry { pattern: "o3-mini",           pin_per_mtok: 1.10, pout_per_mtok: 4.40 },
];

#[derive(Debug, Clone, Copy)]
struct PriceEntry {
    pattern: &'static str,
    pin_per_mtok: f64,
    pout_per_mtok: f64,
}

pub fn cost(model: &str, prompt: u64, completion: u64) -> Option<f64> {
    for e in PRICES {
        if model.contains(e.pattern) {
            let pin = (prompt as f64 / 1_000_000.0) * e.pin_per_mtok;
            let pout = (completion as f64 / 1_000_000.0) * e.pout_per_mtok;
            return Some(pin + pout);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sonnet_prices() {
        let c = cost("claude-3-5-sonnet-20240620", 1_000_000, 1_000_000).unwrap();
        assert!((c - 18.0).abs() < 1e-9);
    }

    #[test]
    fn opus_prices() {
        let c = cost("claude-3-opus-20240229", 1_000_000, 1_000_000).unwrap();
        assert!((c - 90.0).abs() < 1e-9);
    }

    #[test]
    fn haiku_prices() {
        let c = cost("claude-3-haiku-20240307", 2_000_000, 1_000_000).unwrap();
        assert!((c - 1.75).abs() < 1e-9);
    }

    #[test]
    fn unknown_returns_none() {
        assert!(cost("mystery-model-v9", 100, 100).is_none());
    }
}
