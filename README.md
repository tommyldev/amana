# amana - Agent Mana

**A**gent **T**oken **O**bserver & **M**onitor — a single-binary TypeScript/Bun
CLI + TUI that ingests AI usage from local agent logs and admin APIs, fetches
live quota with your own OAuth/API credentials, stores everything in a local
SQLite database, and reports per-provider token/cost usage against your
configured windows and limits — with threshold alerts and a modern tabbed
dashboard.

> The command and package are named `amana`. The project ships from the
> `atop` repository and keeps the `atop` on-disk names (`ATOP_*` env vars,
> `~/.local/share/atop`, `atop.db`) for backward compatibility — see
> [Data & migration](#data--migration).

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

- **[Bun](https://bun.sh) ≥ 1.1** — provides `bun:sqlite`, `bun test`, and the
  single-binary `bun build --compile`. No other runtime is needed. The global
  install and run-from-checkout paths need Bun installed; the standalone binary
  runs on its own once built.
- Linux, macOS, or Windows. Linux is the primary target (XDG paths;
  `notify-send` for desktop alerts).

Install Bun first if you don't have it:

```bash
curl -fsSL https://bun.sh/install | bash
```

## Install

Pick one of the three paths below.

### 1. Global install with Bun (recommended)

Installs the `amana` command straight from the repo. Requires Bun at runtime.

```bash
bun add -g github:tommyldev/atop
amana --help        # the `amana` command is now on your PATH (~/.bun/bin)
```

Update later with `bun update -g amana`; remove with `bun remove -g amana`.

> If `amana` isn't found afterwards, add Bun's global bin dir to your PATH:
> `export PATH="$HOME/.bun/bin:$PATH"` (add it to your shell profile).

### 2. Standalone binary (no Bun needed at runtime)

Compiles a self-contained ~90 MB executable you can drop anywhere.

```bash
git clone https://github.com/tommyldev/atop.git
cd atop
bun install
bun run build                          # produces ./dist/amana
install -Dm755 dist/amana ~/.local/bin/amana   # or: sudo mv dist/amana /usr/local/bin/
amana report
```

Make sure the target dir is on your PATH (`~/.local/bin` usually is).

### 3. Run from a checkout (no install)

```bash
git clone https://github.com/tommyldev/atop.git
cd atop
bun install
bun run start                          # = bun src/index.ts   (launches the TUI)
bun src/index.ts report                # any subcommand works the same way
```

## Quick start

```bash
# 1. See today's usage (runs an incremental sync first).
amana report

# 2. Authenticate providers.
amana login anthropic        # OAuth (browser) → live quota; run twice for two accounts
amana login openai-codex     # OAuth (ChatGPT/Codex)
amana login minimax-code     # OAuth device flow
amana login zai              # API key
amana login openai-api       # admin key → cost ingestion

# 3. Inspect / manage accounts.
amana accounts list
amana accounts remove anthropic --account you@example.com

# 4. Configure windows, limits, and alerts.
amana window set omp --type rolling --duration 5h
amana limit set anthropic --tokens 10000000 --cost 50
amana alerts set --thresholds 75,90,100 --desktop true
amana alerts test            # fire a test notification

# 5. Launch the TUI (default — no args).
amana
```

`report` and `sync` both run an incremental sync first, so a fresh install with
no DB populates on the first invocation.

> Running from a checkout without installing? Replace `amana` with
> `bun src/index.ts` in every command above.

## Commands

| Command | What it does |
| --- | --- |
| `amana` (no args) | Launch the tabbed TUI dashboard (default). |
| `amana report` | Sync + print today's totals and per-provider window status. |
| `amana sync [--full]` | Run ingestion now. `--full` re-reads from byte 0. |
| `amana usage [--json] [--provider <id>]` | Fetch live provider usage/quota. |
| `amana graph [--span 24] [--provider <id>]` | Plot the hourly token-usage rate (tokens/hour) as a text bar chart + per-provider breakdown. |
| `amana login [<id>] [--api-key]` | Authenticate a provider (OAuth, device flow, or API/admin key). |
| `amana accounts list` | List stored accounts (provider, label, kind, expiry). |
| `amana accounts remove <id> [--account <label>]` | Remove one stored account. |
| `amana window set <id> --type <t> …` | Configure the usage window (see below). |
| `amana limit set <id> [--cost] [--tokens]` | Set a per-window token and/or monthly cost cap. |
| `amana alerts set [--thresholds a,b,c] [--desktop true\|false] [--enabled true\|false]` | Configure alerts. |
| `amana alerts test` | Fire a test desktop notification. |

Window flags:

| `--type` | Required flag | Meaning |
| --- | --- | --- |
| `rolling` | `--duration 5h` | Sliding window of the given duration (epoch-grid floored). |
| `daily` | (none) | Calendar day, resets 00:00 UTC. |
| `weekly` | `--weekday mon` | Week anchored on the given weekday. |
| `monthly` | `--day 1` | Month anchored on the given day-of-month. |

## TUI

Two views plus a per-provider drill-in:

- **Overview** — an aggregate hourly token-usage heat chart (green→yellow→red by
  intensity) over all providers, plus one colored usage bar per provider (live
  limits when you've logged in, otherwise local window usage). Select a provider
  and press `Enter` to drill in.
- **Provider** (drill-in) — that provider's live limit bars, its own hourly heat
  chart, and a per-model token/cost table.
- **Settings** — edit alert thresholds and toggle enabled / desktop
  notifications; changes save to `config.toml`. Includes a "send test
  notification" action.

| Key | Action |
| --- | --- |
| `1` / `2` | Overview / Settings · `Tab` cycles |
| `↑`/`↓` or `k`/`j` | Move selection (wraps) |
| `Enter` / `→` / `l` | Overview: open provider · Settings: edit/toggle/run |
| `Space` | Toggle the selected setting |
| `Esc` / `←` / `Backspace` | Back (`Esc` at top level quits) |
| `r` | Force refresh · `t` cycle chart span 12→24→48h |
| `x` | Dismiss alert banner · `?`/`h` help · `q`/`Ctrl-C` quit |

The TUI refreshes on a timer (`ui.refresh_interval_seconds`, default 60) and on
`r`: it syncs logs, fetches live usage, recomputes hourly spend, reloads
accounts, and evaluates alert thresholds (firing the banner + desktop
notification). Alerts fire only from this loop — there is no background daemon.

## Providers

Two log aggregates are enabled by default; everything else is opted in via
`amana login`.

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

`amana usage --provider <id>` and the TUI Limits tab also cover `kimi-code`,
`opencode-go`, `ollama`, and `xai-oauth` where usage endpoints exist.

## Data & migration

- **Config and history carry over.** amana reuses the historical `atop` paths, a
  `config.toml` in the same format, and the same SQLite schema — an existing
  `atop.db` and settings are picked up as-is.
- **Credentials do NOT carry over from the old Rust build.** That build stored
  them encrypted in the OS keyring; this build uses a plain `credentials.json`
  (mode `0600`) in the data dir, matching the Codex/Claude/MiniMax CLI
  convention. Re-run `amana login <provider>` once.

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
bun run build       # single-binary ./dist/amana
```

Layout: `src/{config,db,window,ingest,auth,usage,alerts,report,cli,tui}` plus
`registry.ts` and `price.ts`. Every module is kept under 200 lines.

## License

Dual-licensed under either of [MIT](LICENSE-MIT) or
[Apache-2.0](LICENSE-APACHE), at your option.
