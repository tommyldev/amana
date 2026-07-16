export type SourceKind = "LogOmp" | "LogClaudeCode" | "AdminOpenAI" | "AdminAnthropic";

/**
 * Reset cadence for a provider's quota window(s). Drives the default
 * usage_window + extra_windows in defaultConfig(). Some plans expose two
 * limits at once (a rolling 5h burst limit AND a weekly cap), hence
 * "FiveHourWeekly".
 */
export type Cadence = "FiveHourWeekly" | "FiveHour" | "Daily" | "Monthly";

export interface ProviderDef {
  id: string;
  label: string;
  sourceKind: SourceKind;
  /** For LogOmp providers, the `provider` field value used to filter events. */
  ompProvider: string | null;
  needsKey: boolean;
  cadence: Cadence;
}

const omp = (
  id: string,
  label: string,
  ompProvider: string,
  cadence: Cadence,
): ProviderDef => ({ id, label, sourceKind: "LogOmp", ompProvider, needsKey: false, cadence });

export const KNOWN_PROVIDERS: ProviderDef[] = [
  // log sources
  { id: "omp", label: "oh-my-pi (omp) logs", sourceKind: "LogOmp", ompProvider: null, needsKey: false, cadence: "FiveHour" },
  { id: "claude-code", label: "Claude Code logs", sourceKind: "LogClaudeCode", ompProvider: null, needsKey: false, cadence: "FiveHourWeekly" },
  // omp-log providers (filtered by the `provider` field)
  omp("anthropic", "Anthropic (Claude Pro/Max)", "anthropic", "FiveHourWeekly"),
  omp("github-copilot", "GitHub Copilot", "github-copilot", "Monthly"),
  omp("google-antigravity", "Antigravity (Gemini 3, Claude, GPT-OSS)", "google-antigravity", "Daily"),
  omp("google-gemini-cli", "Google Cloud Code Assist (Gemini CLI)", "google-gemini-cli", "Daily"),
  omp("zai", "Z.AI (GLM Coding Plan)", "zai", "FiveHourWeekly"),
  omp("minimax-code", "MiniMax Coding Plan (International)", "minimax-code", "FiveHourWeekly"),
  omp("minimax-code-cn", "MiniMax Coding Plan (China)", "minimax-code-cn", "FiveHourWeekly"),
  omp("openai-codex", "ChatGPT Plus/Pro (Codex)", "openai-codex", "FiveHourWeekly"),
  omp("cursor", "Cursor (Claude, GPT, etc.)", "cursor", "Monthly"),
  omp("kimi-code", "Kimi Code", "kimi-code", "FiveHourWeekly"),
  omp("moonshot", "Moonshot (Kimi API)", "moonshot", "Monthly"),
  omp("deepseek", "DeepSeek", "deepseek", "Monthly"),
  omp("openrouter", "OpenRouter", "openrouter", "Monthly"),
  omp("litellm", "LiteLLM", "litellm", "Monthly"),
  omp("groq", "Groq", "groq", "Monthly"),
  omp("mistral", "Mistral", "mistral", "Monthly"),
  omp("together", "Together", "together", "Monthly"),
  omp("fireworks", "Fireworks", "fireworks", "Monthly"),
  omp("firepass", "Fire Pass", "firepass", "Monthly"),
  omp("cerebras", "Cerebras", "cerebras", "Monthly"),
  omp("huggingface", "Hugging Face Inference", "huggingface", "Monthly"),
  omp("nvidia", "NVIDIA", "nvidia", "Monthly"),
  omp("xai", "xAI", "xai", "Monthly"),
  omp("xai-oauth", "xAI (OAuth)", "xai-oauth", "Monthly"),
  omp("perplexity", "Perplexity", "perplexity", "Monthly"),
  omp("venice", "Venice", "venice", "Monthly"),
  omp("xiaomi", "Xiaomi MiMo", "xiaomi", "Monthly"),
  omp("nanogpt", "NanoGPT", "nanogpt", "Monthly"),
  omp("kilo", "Kilo Gateway", "kilo", "Monthly"),
  omp("zenmux", "ZenMux", "zenmux", "Monthly"),
  omp("opencode-zen", "OpenCode Zen", "opencode-zen", "Monthly"),
  omp("opencode-go", "OpenCode Go", "opencode-go", "Monthly"),
  omp("alibaba-coding-plan", "Alibaba Coding Plan", "alibaba-coding-plan", "FiveHourWeekly"),
  omp("alibaba-token-plan", "Alibaba Token Plan Enterprise", "alibaba-token-plan", "Monthly"),
  omp("qwen-portal", "Qwen Portal", "qwen-portal", "FiveHourWeekly"),
  omp("qianfan", "Qianfan", "qianfan", "Monthly"),
  omp("gitlab-duo", "GitLab Duo", "gitlab-duo", "Monthly"),
  omp("cloudflare-ai-gateway", "Cloudflare AI Gateway", "cloudflare-ai-gateway", "Monthly"),
  omp("vercel-ai-gateway", "Vercel AI Gateway", "vercel-ai-gateway", "Monthly"),
  omp("synthetic", "Synthetic", "synthetic", "Monthly"),
  // local providers
  omp("ollama", "Ollama (Local)", "ollama", "FiveHour"),
  omp("lm-studio", "LM Studio (Local)", "lm-studio", "FiveHour"),
  omp("llama-cpp", "llama.cpp (Local)", "llama.cpp", "FiveHour"),
  omp("vllm", "vLLM (Local)", "vllm", "FiveHour"),
  // admin-API providers
  { id: "openai-api", label: "OpenAI (admin)", sourceKind: "AdminOpenAI", ompProvider: null, needsKey: true, cadence: "Monthly" },
  { id: "anthropic-api", label: "Anthropic (admin)", sourceKind: "AdminAnthropic", ompProvider: null, needsKey: true, cadence: "Monthly" },
];

export function byId(id: string): ProviderDef | undefined {
  return KNOWN_PROVIDERS.find((p) => p.id === id);
}

export function allIds(): string[] {
  return KNOWN_PROVIDERS.map((p) => p.id);
}

export function sourceKindFor(id: string): SourceKind | undefined {
  return byId(id)?.sourceKind;
}

/** Cadence for a provider id; unknown ids default to monthly. */
export function cadenceFor(id: string): Cadence {
  return byId(id)?.cadence ?? "Monthly";
}
