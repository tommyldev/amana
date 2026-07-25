interface PriceTier {
  pinPerMtok: number;
  poutPerMtok: number;
  cacheReadPerMtok?: number;
  cacheWritePerMtok?: number;
}

interface PriceEntry extends PriceTier {
  pattern: string;
  caseInsensitive?: boolean;
  longContext?: PriceTier & { abovePromptTokens: number };
}

/**
 * Per-million-token prices in USD: (in, out). Ordered first-match wins, so
 * more specific patterns come first. Port of Rust `price.rs`.
 */
const PRICES: PriceEntry[] = [
  { pattern: "claude-3-5-sonnet", pinPerMtok: 3.0, poutPerMtok: 15.0 },
  { pattern: "claude-3-7-sonnet", pinPerMtok: 3.0, poutPerMtok: 15.0 },
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
  {
    pattern: "minimax-m3",
    caseInsensitive: true,
    pinPerMtok: 0.3,
    poutPerMtok: 1.2,
    cacheReadPerMtok: 0.06,
    cacheWritePerMtok: 0,
    longContext: {
      abovePromptTokens: 512_000,
      pinPerMtok: 0.6,
      poutPerMtok: 2.4,
      cacheReadPerMtok: 0.12,
      cacheWritePerMtok: 0,
    },
  },
];

/**
 * Anthropic prompt-cache pricing relative to the base input rate: cache reads
 * bill at 0.1×, 5-minute cache writes at 1.25×. The only computed-cost path is
 * Claude Code (always Claude models), so these multipliers apply where correct.
 */
const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_MULT = 1.25;

/**
 * Estimated cost in USD for a model given prompt/completion (and optional
 * prompt-cache read/write) token counts, or undefined when the model matches
 * no known price pattern. Cache params default to 0 so 3-arg callers are
 * unaffected.
 */
export function cost(
  model: string,
  prompt: number,
  completion: number,
  cacheRead = 0,
  cacheWrite = 0,
): number | undefined {
  for (const e of PRICES) {
    const matches = e.caseInsensitive
      ? model.toLowerCase().includes(e.pattern)
      : model.includes(e.pattern);
    if (matches) {
      const tier = e.longContext && prompt > e.longContext.abovePromptTokens ? e.longContext : e;
      const cacheReadPerMtok = tier.cacheReadPerMtok ?? tier.pinPerMtok * CACHE_READ_MULT;
      const cacheWritePerMtok = tier.cacheWritePerMtok ?? tier.pinPerMtok * CACHE_WRITE_MULT;
      return (
        (prompt / 1_000_000) * tier.pinPerMtok +
        (completion / 1_000_000) * tier.poutPerMtok +
        (cacheRead / 1_000_000) * cacheReadPerMtok +
        (cacheWrite / 1_000_000) * cacheWritePerMtok
      );
    }
  }
  return undefined;
}
