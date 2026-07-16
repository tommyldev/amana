/// Source kind: where atop gets usage events for a provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceKind {
    /// `~/.omp/logs/omp.*.log` — events have a `provider` field that
    /// distinguishes multiple providers sharing the same log source.
    LogOmp,
    /// `~/.claude/projects/**/*.jsonl` — single-provider log source.
    LogClaudeCode,
    /// OpenAI admin API (`/v1/usage`).
    AdminOpenAI,
    /// Anthropic admin API (`/v1/organizations/usage_report`).
    AdminAnthropic,
}

/// Reset cadence for a provider's quota window(s). Drives the default
/// `usage_window` + `extra_windows` in `Config::default`. Some plans expose
/// two limits at once (a rolling 5h burst limit AND a weekly cap), hence
/// `FiveHourWeekly`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cadence {
    /// Rolling 5h burst window + a weekly cap (coding subscriptions).
    FiveHourWeekly,
    /// Rolling 5h tracking window only (aggregates / local providers).
    FiveHour,
    /// Resets daily at midnight.
    Daily,
    /// Resets monthly on a day-of-month (pay-as-you-go gateways).
    Monthly,
}

#[derive(Debug, Clone, Copy)]
pub struct ProviderDef {
    pub id: &'static str,
    pub label: &'static str,
    pub source_kind: SourceKind,
    /// When `source_kind` is `LogOmp`, this is the `provider` field value
    /// used to filter events within the shared `"omp"` source. `None` for
    /// non-log sources (admin APIs are already per-provider).
    pub omp_provider: Option<&'static str>,
    pub needs_key: bool,
    pub cadence: Cadence,
}

/// All providers known to atop. Mirrors the provider list from
/// oh-my-pi (`packages/ai/src/utils/oauth/index.ts` +
/// `packages/ai/src/models.json`) so that every provider appearing in
/// `~/.omp` logs is recognised and can be shown in the dashboard.
pub const KNOWN_PROVIDERS: &[ProviderDef] = &[
    // ── log sources ──────────────────────────────────────────────────
    ProviderDef { id: "omp",                label: "oh-my-pi (omp) logs", source_kind: SourceKind::LogOmp, omp_provider: None, needs_key: false, cadence: Cadence::FiveHour },
    ProviderDef { id: "claude-code",        label: "Claude Code logs",    source_kind: SourceKind::LogClaudeCode, omp_provider: None, needs_key: false, cadence: Cadence::FiveHourWeekly },
    // ── omp-log providers (each filtered by the `provider` field) ────
    ProviderDef { id: "anthropic",          label: "Anthropic (Claude Pro/Max)",         source_kind: SourceKind::LogOmp, omp_provider: Some("anthropic"),          needs_key: false, cadence: Cadence::FiveHourWeekly },
    ProviderDef { id: "github-copilot",     label: "GitHub Copilot",                     source_kind: SourceKind::LogOmp, omp_provider: Some("github-copilot"),     needs_key: false, cadence: Cadence::Monthly },
    ProviderDef { id: "google-antigravity", label: "Antigravity (Gemini 3, Claude, GPT-OSS)", source_kind: SourceKind::LogOmp, omp_provider: Some("google-antigravity"), needs_key: false, cadence: Cadence::Daily },
    ProviderDef { id: "google-gemini-cli",  label: "Google Cloud Code Assist (Gemini CLI)", source_kind: SourceKind::LogOmp, omp_provider: Some("google-gemini-cli"), needs_key: false, cadence: Cadence::Daily },
    ProviderDef { id: "zai",                label: "Z.AI (GLM Coding Plan)",             source_kind: SourceKind::LogOmp, omp_provider: Some("zai"),                needs_key: false, cadence: Cadence::FiveHourWeekly },
    ProviderDef { id: "minimax-code",       label: "MiniMax Coding Plan (International)", source_kind: SourceKind::LogOmp, omp_provider: Some("minimax-code"),       needs_key: false, cadence: Cadence::FiveHourWeekly },
    ProviderDef { id: "minimax-code-cn",    label: "MiniMax Coding Plan (China)",        source_kind: SourceKind::LogOmp, omp_provider: Some("minimax-code-cn"),    needs_key: false, cadence: Cadence::FiveHourWeekly },
    ProviderDef { id: "openai-codex",       label: "ChatGPT Plus/Pro (Codex)",           source_kind: SourceKind::LogOmp, omp_provider: Some("openai-codex"),       needs_key: false, cadence: Cadence::FiveHourWeekly },
    ProviderDef { id: "cursor",             label: "Cursor (Claude, GPT, etc.)",         source_kind: SourceKind::LogOmp, omp_provider: Some("cursor"),             needs_key: false, cadence: Cadence::Monthly },
    ProviderDef { id: "kimi-code",          label: "Kimi Code",                          source_kind: SourceKind::LogOmp, omp_provider: Some("kimi-code"),          needs_key: false, cadence: Cadence::FiveHourWeekly },
    ProviderDef { id: "moonshot",           label: "Moonshot (Kimi API)",                source_kind: SourceKind::LogOmp, omp_provider: Some("moonshot"),           needs_key: false, cadence: Cadence::Monthly },
    ProviderDef { id: "deepseek",           label: "DeepSeek",                           source_kind: SourceKind::LogOmp, omp_provider: Some("deepseek"),           needs_key: false, cadence: Cadence::Monthly },
    ProviderDef { id: "openrouter",         label: "OpenRouter",                         source_kind: SourceKind::LogOmp, omp_provider: Some("openrouter"),         needs_key: false, cadence: Cadence::Monthly },
    ProviderDef { id: "litellm",            label: "LiteLLM",                            source_kind: SourceKind::LogOmp, omp_provider: Some("litellm"),            needs_key: false, cadence: Cadence::Monthly },
    ProviderDef { id: "groq",               label: "Groq",                               source_kind: SourceKind::LogOmp, omp_provider: Some("groq"),               needs_key: false, cadence: Cadence::Monthly },
    ProviderDef { id: "mistral",            label: "Mistral",                            source_kind: SourceKind::LogOmp, omp_provider: Some("mistral"),            needs_key: false, cadence: Cadence::Monthly },
    ProviderDef { id: "together",           label: "Together",                           source_kind: SourceKind::LogOmp, omp_provider: Some("together"),           needs_key: false, cadence: Cadence::Monthly },
    ProviderDef { id: "fireworks",          label: "Fireworks",                          source_kind: SourceKind::LogOmp, omp_provider: Some("fireworks"),          needs_key: false, cadence: Cadence::Monthly },
    ProviderDef { id: "firepass",           label: "Fire Pass",                          source_kind: SourceKind::LogOmp, omp_provider: Some("firepass"),          needs_key: false, cadence: Cadence::Monthly },
    ProviderDef { id: "cerebras",           label: "Cerebras",                           source_kind: SourceKind::LogOmp, omp_provider: Some("cerebras"),           needs_key: false, cadence: Cadence::Monthly },
    ProviderDef { id: "huggingface",        label: "Hugging Face Inference",             source_kind: SourceKind::LogOmp, omp_provider: Some("huggingface"),        needs_key: false, cadence: Cadence::Monthly },
    ProviderDef { id: "nvidia",             label: "NVIDIA",                             source_kind: SourceKind::LogOmp, omp_provider: Some("nvidia"),             needs_key: false, cadence: Cadence::Monthly },
    ProviderDef { id: "xai",                label: "xAI",                                source_kind: SourceKind::LogOmp, omp_provider: Some("xai"),                needs_key: false, cadence: Cadence::Monthly },
    ProviderDef { id: "xai-oauth",          label: "xAI (OAuth)",                        source_kind: SourceKind::LogOmp, omp_provider: Some("xai-oauth"),          needs_key: false, cadence: Cadence::Monthly },
    ProviderDef { id: "perplexity",         label: "Perplexity",                         source_kind: SourceKind::LogOmp, omp_provider: Some("perplexity"),         needs_key: false, cadence: Cadence::Monthly },
    ProviderDef { id: "venice",             label: "Venice",                             source_kind: SourceKind::LogOmp, omp_provider: Some("venice"),             needs_key: false, cadence: Cadence::Monthly },
    ProviderDef { id: "xiaomi",             label: "Xiaomi MiMo",                        source_kind: SourceKind::LogOmp, omp_provider: Some("xiaomi"),             needs_key: false, cadence: Cadence::Monthly },
    ProviderDef { id: "nanogpt",            label: "NanoGPT",                            source_kind: SourceKind::LogOmp, omp_provider: Some("nanogpt"),            needs_key: false, cadence: Cadence::Monthly },
    ProviderDef { id: "kilo",               label: "Kilo Gateway",                       source_kind: SourceKind::LogOmp, omp_provider: Some("kilo"),               needs_key: false, cadence: Cadence::Monthly },
    ProviderDef { id: "zenmux",             label: "ZenMux",                             source_kind: SourceKind::LogOmp, omp_provider: Some("zenmux"),             needs_key: false, cadence: Cadence::Monthly },
    ProviderDef { id: "opencode-zen",       label: "OpenCode Zen",                       source_kind: SourceKind::LogOmp, omp_provider: Some("opencode-zen"),       needs_key: false, cadence: Cadence::Monthly },
    ProviderDef { id: "opencode-go",        label: "OpenCode Go",                        source_kind: SourceKind::LogOmp, omp_provider: Some("opencode-go"),        needs_key: false, cadence: Cadence::Monthly },
    ProviderDef { id: "alibaba-coding-plan",label: "Alibaba Coding Plan",                source_kind: SourceKind::LogOmp, omp_provider: Some("alibaba-coding-plan"),needs_key: false, cadence: Cadence::FiveHourWeekly },
    ProviderDef { id: "alibaba-token-plan", label: "Alibaba Token Plan Enterprise",      source_kind: SourceKind::LogOmp, omp_provider: Some("alibaba-token-plan"), needs_key: false, cadence: Cadence::Monthly },
    ProviderDef { id: "qwen-portal",        label: "Qwen Portal",                        source_kind: SourceKind::LogOmp, omp_provider: Some("qwen-portal"),        needs_key: false, cadence: Cadence::FiveHourWeekly },
    ProviderDef { id: "qianfan",            label: "Qianfan",                            source_kind: SourceKind::LogOmp, omp_provider: Some("qianfan"),            needs_key: false, cadence: Cadence::Monthly },
    ProviderDef { id: "gitlab-duo",         label: "GitLab Duo",                         source_kind: SourceKind::LogOmp, omp_provider: Some("gitlab-duo"),         needs_key: false, cadence: Cadence::Monthly },
    ProviderDef { id: "cloudflare-ai-gateway", label: "Cloudflare AI Gateway",          source_kind: SourceKind::LogOmp, omp_provider: Some("cloudflare-ai-gateway"), needs_key: false, cadence: Cadence::Monthly },
    ProviderDef { id: "vercel-ai-gateway",  label: "Vercel AI Gateway",                  source_kind: SourceKind::LogOmp, omp_provider: Some("vercel-ai-gateway"),  needs_key: false, cadence: Cadence::Monthly },
    ProviderDef { id: "synthetic",          label: "Synthetic",                          source_kind: SourceKind::LogOmp, omp_provider: Some("synthetic"),          needs_key: false, cadence: Cadence::Monthly },
    // ── local providers (appear in omp logs when running locally) ────
    ProviderDef { id: "ollama",             label: "Ollama (Local)",                     source_kind: SourceKind::LogOmp, omp_provider: Some("ollama"),             needs_key: false, cadence: Cadence::FiveHour },
    ProviderDef { id: "lm-studio",          label: "LM Studio (Local)",                  source_kind: SourceKind::LogOmp, omp_provider: Some("lm-studio"),          needs_key: false, cadence: Cadence::FiveHour },
    ProviderDef { id: "llama-cpp",          label: "llama.cpp (Local)",                  source_kind: SourceKind::LogOmp, omp_provider: Some("llama.cpp"),          needs_key: false, cadence: Cadence::FiveHour },
    ProviderDef { id: "vllm",               label: "vLLM (Local)",                       source_kind: SourceKind::LogOmp, omp_provider: Some("vllm"),               needs_key: false, cadence: Cadence::FiveHour },
    // ── admin-API providers (future: direct usage API fetch) ─────────
    ProviderDef { id: "openai-api",         label: "OpenAI (admin)",      source_kind: SourceKind::AdminOpenAI,    omp_provider: None, needs_key: true, cadence: Cadence::Monthly },
    ProviderDef { id: "anthropic-api",      label: "Anthropic (admin)",   source_kind: SourceKind::AdminAnthropic, omp_provider: None, needs_key: true, cadence: Cadence::Monthly },
];

pub fn by_id(id: &str) -> Option<&'static ProviderDef> {
    KNOWN_PROVIDERS.iter().find(|p| p.id == id)
}

pub fn all_ids() -> Vec<&'static str> {
    KNOWN_PROVIDERS.iter().map(|p| p.id).collect()
}

pub fn source_kind_for(id: &str) -> Option<SourceKind> {
    by_id(id).map(|p| p.source_kind)
}

/// Cadence for a provider id. Unknown providers (e.g. ad-hoc rows discovered
/// in the DB) default to monthly.
pub fn cadence_for(id: &str) -> Cadence {
    by_id(id).map(|d| d.cadence).unwrap_or(Cadence::Monthly)
}