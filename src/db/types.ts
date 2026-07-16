export interface UsageEventRow {
  source: string;
  source_message_id: string;
  timestamp_ms: number;
  provider: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  cost_usd: number | null;
  cost_origin: string;
}

export interface UsageAggregate {
  requests: number;
  prompt: number;
  completion: number;
  total: number;
  cost: number;
}

export interface ModelBreakdown {
  model: string;
  requests: number;
  total_tokens: number;
  cost: number;
}

export interface ProviderHourly {
  provider: string;
  buckets: number[];
  totalTokens: number;
  estCost: number;
}
