interface PriceEntry {
  pattern: string;
  pinPerMtok: number;
  poutPerMtok: number;
}

/**
 * Per-million-token prices in USD: (in, out). Ordered first-match wins, so
 * more specific patterns come first. Port of Rust `price.rs`.
 */
const PRICES: PriceEntry[] = [
  { pattern: "claude-3-5-sonnet", pinPerMtok: 3.0, poutPerMtok: 15.0 },
  { pattern: "claude-sonnet-4", pinPerMtok: 3.0, poutPerMtok: 15.0 },
  { pattern: "claude-opus-4", pinPerMtok: 15.0, poutPerMtok: 75.0 },
  { pattern: "claude-3-opus", pinPerMtok: 15.0, poutPerMtok: 75.0 },
  { pattern: "claude-haiku-4", pinPerMtok: 1.0, poutPerMtok: 5.0 },
  { pattern: "claude-3-5-haiku", pinPerMtok: 0.8, poutPerMtok: 4.0 },
  { pattern: "claude-3-haiku", pinPerMtok: 0.25, poutPerMtok: 1.25 },
  { pattern: "gpt-4o", pinPerMtok: 2.5, poutPerMtok: 10.0 },
  { pattern: "gpt-4-turbo", pinPerMtok: 10.0, poutPerMtok: 30.0 },
  { pattern: "gpt-4", pinPerMtok: 30.0, poutPerMtok: 60.0 },
  { pattern: "gpt-3.5-turbo", pinPerMtok: 0.5, poutPerMtok: 1.5 },
  { pattern: "o1", pinPerMtok: 15.0, poutPerMtok: 60.0 },
  { pattern: "o3-mini", pinPerMtok: 1.1, poutPerMtok: 4.4 },
];

/** Estimated cost in USD for a model given prompt/completion token counts,
 * or undefined when the model matches no known price pattern. */
export function cost(model: string, prompt: number, completion: number): number | undefined {
  for (const e of PRICES) {
    if (model.includes(e.pattern)) {
      return (prompt / 1_000_000) * e.pinPerMtok + (completion / 1_000_000) * e.poutPerMtok;
    }
  }
  return undefined;
}
