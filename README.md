# atop

Agent Token Observer & Monitor — a single-binary CLI that ingests usage data from
local agent logs and admin APIs, stores it in a local SQLite database, and
reports per-provider token / cost usage against your configured window and
limits.

## Features

- **Local-first.** SQLite database lives under your XDG data directory; nothing
  leaves the machine except outbound admin-API calls you opt into.
- **Multi-source ingestion.** Two log-file sources (`omp`, `claude-code`) and
  two admin-API sources (`openai-api`, `anthropic-api`) ship out of the box.
- **Incremental sync.** Tracks byte offset + mtime per source file, so reruns
  only parse new bytes.
- **Usage windows.** Rolling (`5h`), `Daily`, `Weekly` (with `--weekday`), and
  `Monthly` (with `--day`).
- **Limits.** Per-provider token and/or monthly cost caps; a `--help`-style
  status row surfaces them.

## Requirements

- Rust **1.75+** (edition 2021, `clap` 4.5 derive macros).
- `pkg-config` + a C toolchain — `rusqlite` is `bundled`, so no system SQLite
  is needed.
- Linux, macOS, or Windows. Linux is the primary target (XDG paths).

## Install

```bash
git clone <repo-url> atop
cd atop
cargo install --path .
```

Or just run from a checkout:

```bash
cargo run -- report
```

## Quick start

```bash
# 1. See what's configured (and what your usage looks like today).
cargo run -- report

# 2. Authenticate a provider (OAuth for live usage, or admin key for ingestion).
cargo run -- login anthropic         # OAuth → live quota in the TUI
cargo run -- login openai-api        # admin key → cost ingestion

# 3. Change a provider's active usage window.
cargo run -- window set omp --type rolling --duration 5h
cargo run -- window set claude-code --type daily

# 4. Set a token / cost cap.
cargo run -- limit set openai-api --cost 50 --tokens 10_000_000

# 5. Launch the TUI (the default — no args).
cargo run
```

`report` and `sync` both run an incremental sync first, so a fresh
checkout with no DB will populate on the first invocation.


## Commands

| Command                                      | What it does                                                 |
| -------------------------------------------- | ------------------------------------------------------------ |
| `atop` (no args)                             | Launch the token-usage TUI dashboard (default).              |
| `atop report`                                | Sync + print today's totals (text).                          |
| `atop sync [--full]`                         | Run ingestion now. `--full` re-reads from byte 0.            |
| `atop login <id>`                            | Authenticate a provider; admin-API ids (`openai-api`, `anthropic-api`) set the ingestion key. |
| `atop window set <provider> --type <t> ...`  | Configure the usage window (see below).                      |
| `atop limit set <provider> [--cost] [--tokens]` | Set a per-window token and/or monthly cost cap.            |
| `Tab` (in TUI)                               | Switch between token-usage and live-capacity screens.       |

Window flags (mutually exclusive with `--type`):

| `--type`  | Required flags          | Meaning                                      |
| --------- | ----------------------- | -------------------------------------------- |
| `rolling` | `--duration 5h`         | Sliding window of the given duration.        |
| `daily`   | (none)                  | Calendar day, resets at 00:00 UTC.           |
| `weekly`  | `--weekday mon`         | Week anchored on the given weekday.          |
| `monthly` | `--day 1`               | Month anchored on the given day-of-month.    |

## Providers

| Id             | Source                | Needs admin key | Default window |
| -------------- | --------------------- | --------------- | -------------- |
| `omp`          | `~/.omp/agent/sessions` (`*.jsonl`) | No  | Rolling 5h     |
| `claude-code`  | `~/.claude/projects`  (`*.jsonl`)    | No  | Rolling 5h     |
Two providers are enabled by default (`omp`, `claude-code`). The admin-API
providers start disabled and are turned on by `atop login <id>`.

## Environment variables

| Variable                | Effect                                                           |
| ----------------------- | ---------------------------------------------------------------- |
| `ATOP_CONFIG_DIR`       | Override the XDG config dir; `config.toml` is read/written here. |
| `ATOP_DATA_DIR`         | Override the XDG data dir; SQLite db lives here as `atop.db`.    |
| `ATOP_OMP_DIR`          | Override the root for `omp` jsonl ingestion.                     |
| `ATOP_CLAUDE_DIR`       | Override the root for `claude-code` jsonl ingestion.             |

Defaults (Linux):

- Config: `${XDG_CONFIG_HOME:-~/.config}/atop/config.toml`
- Data:   `${XDG_DATA_HOME:-~/.local/share}/atop/atop.db`

## Layout

```text
.
├── Cargo.toml            # package + deps (all pinned to =x.y)
├── src/
│   ├── main.rs           # tokio entry: Cli::parse().run()
│   ├── lib.rs            # module surface
│   ├── cli/              # clap subcommands + handlers
│   ├── config/           # Config, Paths, ProviderCfg, defaults
│   ├── source/           # trait + per-provider fetchers
│   │   ├── omp/          # log-file ingestion
│   │   ├── claude_code/  # log-file ingestion
│   │   ├── admin_openai.rs
│   │   └── admin_anthropic.rs
│   ├── db/               # rusqlite schema, insert, query
│   ├── window/           # rolling / daily / weekly / monthly logic
│   ├── report/           # stdout rendering
│   ├── price.rs          # per-model token -> cost
│   ├── secret.rs         # OS keyring via the `keyring` crate
│   └── sync.rs           # fan-out runner
└── README.md
```

## Development

```bash
cargo build              # debug build
cargo test               # full test suite (uses tempfile + ATOP_* env vars)
cargo run -- report      # run against your real data dir
```

Each test that touches disk sets `ATOP_CONFIG_DIR` / `ATOP_DATA_DIR` to a
`tempfile::TempDir`, so they are hermetic and safe to run in parallel.

## License

Dual-licensed under MIT or Apache-2.0, at your option.