# atop

Agent Token Observer & Monitor — a single-binary TypeScript/Bun CLI + TUI that
ingests AI usage from local agent logs and admin APIs, fetches live quota with
your own OAuth/API credentials, stores everything in a local SQLite database,
and reports per-provider token/cost usage against your configured windows and
limits — with threshold alerts and a modern tabbed dashboard.

## Features

- **Local-first.** SQLite lives under your XDG data dir; nothing leaves the
  machine except the provider API calls you opt into.
- **Multi-source ingestion.** Log-file sources (`omp`, `claude-code`) plus admin
  APIs (`openai-api`, `anthropic-api`), incrementally tailed by byte offset +
  mtime so reruns only parse new bytes.
- **Live usage.** Fetches real quota/limits directly from 12 providers (Anthropic,
  ChatGPT/Codex, Z.AI, MiniMax, Gemini, Copilot, and more).
- **Multiple accounts per provider.** Log in to the same provider several times
  (e.g. two Anthropic accounts); each distinct account is tracked separately.
- **Threshold alerts.** Configurable thresholds (default 75/90/100%) fire a
  desktop notification (`notify-send`/`osascript`) and an in-TUI banner when a
  limit is crossed — deduped per window, re-armed after each reset.
- **Token spend by hour.** Per-provider hourly token/cost charts in the TUI.
- **Windows & limits.** Rolling (`5h`), daily, weekly (`--weekday`), monthly
  (`--day`); per-provider token and/or monthly-cost caps.

## Requirements

- **[Bun](https://bun.sh) ≥ 1.1** (provides `bun:sqlite`, `bun test`, and
  single-binary `bun build --compile`). No other runtime needed.
- Linux, macOS, or Windows. Linux is the primary target (XDG paths;
  `notify-send` for desktop alerts).

## Install

```bash
git clone <repo-url> atop
cd atop
bun install
bun run build          # produces a self-contained ./dist/atop binary
./dist/atop report
```

Or run straight from the checkout without compiling:

```bash
bun run start          # = bun src/index.ts   (launches the TUI)
bun src/index.ts report
```

## Quick start

```bash
# 1. See today's usage (runs an incremental sync first).
bun src/index.ts report

# 2. Authenticate providers.
bun src/index.ts login anthropic        # OAuth (browser) → live quota; run twice for two accounts
bun src/index.ts login openai-codex     # OAuth (ChatGPT/Codex)
bun src/index.ts login minimax-code     # OAuth device flow
bun src/index.ts login zai              # API key
bun src/index.ts login openai-api       # admin key → cost ingestion

# 3. Inspect / manage accounts.
bun src/index.ts accounts list
bun src/index.ts accounts remove anthropic --account you@example.com

# 4. Configure windows, limits, and alerts.
bun src/index.ts window set omp --type rolling --duration 5h
bun src/index.ts limit set anthropic --tokens 10000000 --cost 50
bun src/index.ts alerts set --thresholds 75,90,100 --desktop true
bun src/index.ts alerts test            # fire a test notification

# 5. Launch the TUI (default — no args).
bun src/index.ts
```

`report` and `sync` both run an incremental sync first, so a fresh checkout
with no DB populates on the first invocation.

## Commands

| Command | What it does |
| --- | --- |
| `atop` (no args) | Launch the tabbed TUI dashboard (default). |
| `atop report` | Sync + print today's totals and per-provider window status. |
| `atop sync [--full]` | Run ingestion now. `--full` re-reads from byte 0. |
| `atop usage [--json] [--provider <id>]` | Fetch live provider usage/quota. |
| `atop graph [--span 24] [--provider <id>]` | Plot the hourly token-usage rate (tokens/hour) as a text bar chart + per-provider breakdown. |
| `atop login [<id>] [--api-key]` | Authenticate a provider (OAuth, device flow, or API/admin key). |
| `atop accounts list` | List stored accounts (provider, label, kind, expiry). |
| `atop accounts remove <id> [--account <label>]` | Remove one stored account. |
| `atop window set <id> --type <t> …` | Configure the usage window (see below). |
| `atop limit set <id> [--cost] [--tokens]` | Set a per-window token and/or monthly cost cap. |
| `atop alerts set [--thresholds a,b,c] [--desktop true\|false] [--enabled true\|false]` | Configure alerts. |
| `atop alerts test` | Fire a test desktop notification. |

Window flags:

| `--type` | Required flag | Meaning |
| --- | --- | --- |
| `rolling` | `--duration 5h` | Sliding window of the given duration (epoch-grid floored). |
| `daily` | (none) | Calendar day, resets 00:00 UTC. |
| `weekly` | `--weekday mon` | Week anchored on the given weekday. |
| `monthly` | `--day 1` | Month anchored on the given day-of-month. |

## TUI

Three top-level tabs — **Limits**, **Tokens**, **Accounts** — with drill-ins.

| Key | Action |
| --- | --- |
| `1` / `2` / `3` | Jump to a tab · `Tab` cycles |
| `↑`/`↓` or `k`/`j` | Move selection (wraps) |
| `Enter` / `→` / `l` | Drill into the selected provider |
| `Esc` / `←` / `Backspace` | Back (`Esc` at top level quits) |
| `r` | Force refresh · `t` cycle token span 12→24→48h |
| `x` | Dismiss alert banner · `?`/`h` help · `q`/`Ctrl-C` quit |

The TUI refreshes on a timer (`ui.refresh_interval_seconds`, default 60) and on
`r`: it syncs logs, fetches live usage, recomputes hourly spend, reloads
accounts, and evaluates alert thresholds (firing the banner + desktop
notification). Alerts fire only from this loop — there is no background daemon.

## Providers

Two log aggregates are enabled by default; everything else is opted in via
`atop login`.

| Id | Source / auth | Default window |
| --- | --- | --- |
| `omp` | `~/.omp/agent/sessions` (`*.jsonl`) | Rolling 5h |
| `claude-code` | `~/.claude/projects` (`*.jsonl`) | Rolling 5h + weekly |
| `anthropic` | OAuth (Claude Pro/Max) | Rolling 5h + weekly |
| `openai-codex` | OAuth (ChatGPT/Codex) | Rolling 5h + weekly |
| `minimax-code` / `-cn` | OAuth device flow | Rolling 5h + weekly |
| `google-antigravity` / `google-gemini-cli` | OAuth | Daily |
| `zai` | API key | Rolling 5h + weekly |
| `github-copilot` | API key (+ optional enterprise URL) | Monthly |
| `openai-api` / `anthropic-api` | Admin key → cost ingestion | Monthly |

`atop usage --provider <id>` and the TUI Limits tab also cover `kimi-code`,
`opencode-go`, `ollama`, and `xai-oauth` where usage endpoints exist.

## Data & migration from the Rust build

- **Config and history carry over.** Same paths, same `config.toml` format, same
  SQLite schema — your existing `atop.db` and settings are reused as-is.
- **Credentials do NOT carry over.** The Rust build stored them encrypted in the
  OS keyring; this build uses a plain `credentials.json` (mode `0600`) in the
  data dir, matching the Codex/Claude/MiniMax CLI convention. Re-run
  `atop login <provider>` once.

## Environment variables

| Variable | Effect |
| --- | --- |
| `ATOP_CONFIG_DIR` | Override the config dir; `config.toml` is read/written here. |
| `ATOP_DATA_DIR` | Override the data dir; holds `atop.db` and `credentials.json`. |
| `ATOP_OMP_DIR` | Root for `omp` jsonl ingestion. |
| `ATOP_CLAUDE_DIR` | Root for `claude-code` jsonl ingestion. |

Defaults (Linux): config `${XDG_CONFIG_HOME:-~/.config}/atop`, data
`${XDG_DATA_HOME:-~/.local/share}/atop`.

## Development

```bash
bun test            # full suite (hermetic: each disk test uses a temp ATOP_* dir)
bun run typecheck   # tsc --noEmit
bun run build       # single-binary ./dist/atop
```

Layout: `src/{config,db,window,ingest,auth,usage,alerts,report,cli,tui}` plus
`registry.ts` and `price.ts`. Every module is kept under 200 lines.

## License

Dual-licensed under MIT or Apache-2.0, at your option.
