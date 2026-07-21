# amana parity loop log

Running the loop in `docs/parity-loop-prompt.md`. One entry per gap:
`SELECT` → verdict (`SHIPPED` / `BLOCKED` / `SKIPPED`) with evidence.

---

## Cycle 1 — Multi-window providers hide their secondary (weekly) window
- **Status:** SHIPPED
- **Reference behavior:** Provider dashboards for plans with two concurrent
  limits (Anthropic Claude Pro/Max, Codex, Z.AI) show BOTH a rolling 5-hour
  burst limit AND a weekly cap. A good monitor surfaces both so you never blow
  the weekly cap while the 5h reads 0%.
- **Current amana behavior:** For local (non-live) providers, `amana report`
  renders only `soonest(view)` and the TUI Limits view renders only
  `primary(snap)` — i.e. one window per provider. `defaults.ts` gives every
  `FiveHourWeekly` provider `extra_windows = [weekly]`, and `buildView`
  (snapshot.ts) already computes usage for every configured window, but the
  weekly window is silently dropped in both surfaces. Reset display is also
  inconsistent: `report` shows a rolling reset, the TUI Limits view shows none.
- **Eligible:** Yes — pure local rendering of already-computed data. No server,
  no daemon, no new deps, read-only, files stay <200 lines.
- **Done when:**
  1. `amana report` prints one status line per *configured* window
     (`usage_window` + each `extra_window`) for every enabled provider — a
     `FiveHourWeekly` provider shows both a `[rolling 5h]` line and a `[weekly]`
     line, each with that window's own usage/cost/reset (bar + % only when that
     window has a token limit; usage-only otherwise).
  2. The TUI Limits view lists one row per configured window for local
     (non-live) providers, consistent with `report` (own usage/desc/reset;
     gauge only when a token limit is set). Live providers are unchanged.
  3. Reset display is consistent between `report` and the TUI Limits view: each
     window shows "resets in …" from its own `active.nextReset`.
  4. New vitest asserts: a `FiveHourWeekly` provider yields 2 report lines and
     2 local limit rows; a single-window provider yields 1; a secondary window
     reflects its own window's usage total (distinct from the primary's).
  5. `bun run typecheck` + `bun run build` clean; full `bun test` green; no
     regressions; every touched file stays <200 lines.

### Verdict: SHIPPED

Fix (fixer subagent hit a provider 429 rate-limit; implemented + verified
directly in-session):
- `src/report/report.ts` — `renderReport` now emits one line per configured
  window (per-window token limit via `windowUsed`, never borrowing the
  primary's cap).
- `src/tui/views/limitRows.ts` — NEW module (extracted `LimitRow` +
  `buildLimitRows` from `derive.ts` to stay <200 lines). Local branch emits one
  usage row per window with each window's own `resetsAt`. Dropped the redundant
  per-provider "no limits" note row (login hint already lives in the footer +
  help overlay); removed the now-dead `note` field + its `LimitsView` branch.
- `src/tui/state.ts`, `src/tui/useRefresh.ts` — repointed `LimitRow` /
  `buildLimitRows` imports to the new module.
- Tests: `src/report/report.test.ts` (3), `src/tui/views/limitRows.test.ts` (4)
  — assert 2 lines/rows for a FiveHourWeekly provider, 1 for single-window,
  distinct per-window usage totals, and per-window resets.

Evidence:
- `bun run typecheck` → clean. `bun run build` → `built dist/amana`.
- `bun test` (17 amana files) → `142 pass, 0 fail`.
- `amana report` tail:
  ```
  omp   [rolling 5h]   resets in 3h 34m   ░░░░░░░░░░   0%  ·  133.7M tok $79.03
  claude-code   [rolling 5h]   resets in 3h 34m   ░░░░░░░░░░   0%  ·  0 tok -
  claude-code   [weekly mon]   resets in 24h 34m   ░░░░░░░░░░   0%  ·  106.8k tok $0.55
  ```
- TUI Limits render (ink-testing-library): `.pr-assets/limits-view.txt`
  (populated multi-window / empty / error states).
- Line counts: report.ts 43, derive.ts 104, limitRows.ts 108, LimitsView.tsx 53
  — all <200.

---

## Cycle 2 — Threshold alerts never fire for local providers

- **Status:** SHIPPED
- **Reference behavior:** The README headlines "Threshold alerts. Configurable
  thresholds (default 75/90/100%) fire a desktop notification and an in-TUI
  banner when a limit is crossed." A monitor's whole point is to warn you
  BEFORE you hit a cap.
- **Current amana behavior:** `useRefresh.ts` step 5 calls
  `checkAndFire(db, cfg.alerts, reports)` with ONLY live `reports`. Local
  providers — the default `omp`/`claude-code` and anything with
  `amana limit set <id> --tokens N` but no live login — are never evaluated,
  so a configured token cap can hit 100% and no alert ever fires. The
  advertised `limit set` + alerts combination is dead for local providers.
- **Eligible:** Yes — pure local computation from already-ingested usage; no
  server, no daemon, no deps, files <200 lines.
- **Done when:**
  1. A local provider (no live report) with a configured `window_token_limit`
     fires a threshold alert (banner + desktop notify) when its primary-window
     usage crosses a configured threshold, via the existing `checkAndFire`
     dedup (re-armed each window reset).
  2. Live-quota providers are unaffected (no double-firing); a provider with a
     live report for the cycle is NOT also evaluated locally.
  3. Providers with no configured token limit produce no local alert (no
     out-of-box alert spam, since defaults set no limits).
  4. New vitest asserts: synthetic local report is built with the correct
     usedFraction + reset; crossing a threshold fires once and dedups on the
     second call; a live-covered or limitless provider yields nothing.
  5. `bun run typecheck` + `bun run build` clean; full `bun test` green; no
     regressions; every touched file <200 lines.

### Verdict: SHIPPED

Fix (implemented + verified in-session; subagent path still 429-limited):
- `src/alerts/local.ts` — NEW pure `localAlertReports(cfg, snap, liveProviders)`
  building one synthetic `UsageReport` per enabled local provider that has a
  configured `window_token_limit`, no live report this cycle, and a resolvable
  primary window. `usedFraction` + `window.resetsAt` come from the snapshot, so
  `checkAndFire` dedups per window reset exactly like live limits.
- `src/tui/useRefresh.ts` — step 5 now fires on `[...reports, ...localReports]`
  (live providers excluded from the local set). `snap` hoisted from 4c for reuse.
- Tests: `src/alerts/local.test.ts` (5) — usedFraction/reset construction,
  fire-once-then-dedup, below-threshold silence, exclusion when no limit / when
  live-covered.

Evidence:
- `bun run typecheck` clean; `bun run build` → `built dist/amana`.
- `bun test` (18 amana files) → `147 pass, 0 fail`.
- End-to-end smoke (mirrors useRefresh step 5): claude-code local, cap 10000,
  used 9500 →
  ```
  fired: 1
  banner: ⚠ claude-code local token budget · rolling 5h at 95% (≥90%)
  second call (dedup): 0
  ```
- Line counts: local.ts 39, useRefresh.ts 199 — all <200.

Non-goal noted: monthly-cost-cap alerting for local providers is out of scope
this cycle (token cap only) — a candidate for a later cycle.

---

## Cycle 3 — Provider drill-in shows no window usage for local providers

- **Status:** SHIPPED
- **Reference behavior:** A provider dashboard's detail view leads with that
  provider's window usage/limits. Overview and Limits both show per-window
  local usage (cycle 1); the drill-in should too.
- **Current amana behavior:** `ProviderView` renders window bars only from live
  `reports`. Drilling into a local provider (default `omp`/`claude-code`, or any
  logged-usage provider without a login) shows the header + chart + model table
  but NO window usage summary — inconsistent with Overview/Limits.
- **Eligible:** Yes — reuses `state.limitRows` (already per-window since cycle
  1); no new computation, no deps, files <200 lines.
- **Done when:**
  1. Drilling into a local provider (no live report) shows one window row per
     configured window (desc + usage + gauge when a limit is set + reset),
     reusing `state.limitRows` and the existing `LineGauge`/`resetsIn` helpers.
  2. Live providers are unchanged (per-account live limits still render).
  3. New test renders `ProviderView` for a local provider and asserts the
     window desc + token usage appear.
  4. `bun run typecheck` + `bun run build` clean; full `bun test` green; no
     regressions; captured render in `.pr-assets/`; files <200 lines.

### Verdict: SHIPPED

Fix (implemented + verified in-session; subagent path still 429-limited):
- `src/tui/views/ProviderView.tsx` — when a drilled provider has no live
  `reports`, render one row per configured window from the shared
  `state.limitRows` (per-window since cycle 1), reusing `LineGauge` (gauge when
  a token cap is set, usage-only otherwise) + the existing `resetsIn` helper. A
  trailing space guarantees separation for long labels. Live path unchanged.
- Tests: `src/tui/views/ProviderView.test.tsx` (2) — asserts per-window usage
  rows render for a local provider (usage-only + `token budget` gauge lines).

Evidence:
- `bun run typecheck` clean; `bun run build` → `built dist/amana`.
- `bun test` (19 amana files) → `149 pass, 0 fail`.
- Render → `.pr-assets/provider-drill-in.txt`. Gauge line:
  ```
  token budget · rolling 5h ● ████████░░░░░░░░░░░░ 42%  4.2k / 10.0k tok · resets in 3h 24m
  usage · weekly mon        4.2k tok · resets in 24h 24m
  ```
- Line counts: ProviderView.tsx 99 — all <200.

---

## Cycle 4 — Computed cost drops cache tokens (undercounts Claude Code)

- **Status:** SHIPPED
- **Reference behavior:** Anthropic bills prompt-cache **reads at 0.1×** the base
  input rate and 5-minute cache **writes at 1.25×**. Agentic Claude Code usage
  is cache-dominated (cache reads routinely dwarf fresh input), so cost must
  include cache tokens — provider dashboards do.
- **Current amana behavior:** `price.ts::cost(model, prompt, completion)` ignores
  cache entirely, and `ingest/claudeCode.ts` calls it with only prompt+completion
  even though it parses and stores `cache_read_tokens`/`cache_write_tokens`. The
  default `claude-code` provider's computed `$` is materially undercounted; omp
  (logged cost) and admin (api cost) paths are unaffected.
- **Eligible:** Yes — local pricing math, no deps, back-compat signature.
- **Done when:**
  1. `cost()` accounts for cache read (0.1× input) and cache write (1.25× input)
     via optional params that default to 0 (existing 3-arg callers unchanged).
  2. `ingest/claudeCode.ts` passes the parsed cache tokens into `cost()`.
  3. New tests: cache read/write price at the correct multiples; a cache-heavy
     call costs strictly more than the cache-blind computation; a claude-code
     line with cache tokens yields a cost reflecting them.
  4. `bun run typecheck` + `bun run build` clean; full `bun test` green; no
     regressions; files <200 lines.

### Verdict: SHIPPED

Fix (implemented + verified in-session; subagent path still 429-limited):
- `src/price.ts` — `cost()` gains optional `cacheRead`/`cacheWrite` params
  (default 0) billed at 0.1× / 1.25× the model's base input rate
  (`CACHE_READ_MULT` / `CACHE_WRITE_MULT`). 3-arg callers unchanged.
- `src/ingest/claudeCode.ts` — passes the parsed `cacheRead`/`cacheWrite` into
  `cost()`. omp (logged) and admin (api) cost paths untouched.
- Tests: `src/price.test.ts` (+4: read 0.1×, write 1.25×, additive delta,
  3-arg back-compat) and `src/ingest/claudeCode.test.ts` (+1: cache tokens
  flow into computed `cost_usd`).

Evidence:
- `bun run typecheck` clean; `bun run build` → `built dist/amana`.
- `bun test` (19 amana files) → `154 pass, 0 fail`.
- Smoke (realistic agentic turn: 1.2k in / 800 out / 450k cache-read / 30k
  cache-write, claude-sonnet-4):
  ```
  cache-aware cost = $0.2631
  cache-blind cost = $0.0156  (undercount: 94%)
  ```
- Line counts: price.ts 59, claudeCode.ts 104 — all <200.

---

## Cycle 5 — Overview bar lies for limitless providers (share ≠ utilization)

- **Status:** SHIPPED
- **Reference behavior:** A utilization bar means "how much of your limit is
  used." A monitor must not render a full/red bar for a provider you're nowhere
  near limiting.
- **Current amana behavior (bug):** In `buildOverviewRows`, a provider with no
  live quota and no configured token cap got `pct = used / grandTotal` (share of
  span usage), and `OverviewView` always rendered a `LineGauge`. `LineGauge`
  colors by `statusOf(pct/100)`, so a sole active provider (100% share) showed a
  RED "exhausted" bar despite having no limit — a false alarm.
- **Done when:** gauge renders only when pct reflects a real limit (live or
  configured token cap); limitless rows show usage + explicit share text with no
  bar; tests + captured render; typecheck/build/suite green; files <200.

### Verdict: SHIPPED

Fix (implemented + verified in-session; subagent path still 429-limited):
- `src/tui/views/derive.ts` — `OverviewRow` gains `gauge: boolean`; live and
  configured-token-cap rows set `gauge:true`, the share fallback sets
  `gauge:false` and states the share in `detail` (`"1.0k tok · 18% of 24h"`);
  error rows `gauge:false`.
- `src/tui/views/OverviewView.tsx` — renders `LineGauge` only when `row.gauge`.
- `src/tui/state.test.ts` — `row()` helper updated for the new field.
- Tests: `src/tui/views/overviewRows.test.ts` (4) — limitless→no gauge+share
  text, token cap→gauge+utilization pct, live→gauge, error→no gauge.

Evidence:
- `bun run typecheck` clean; `bun run build` → `built dist/amana`.
- `bun test` (20 amana files) → `158 pass, 0 fail`.
- Render → `.pr-assets/overview-view.txt`:
  ```
  › Claude Code logs       ● ██████████████████░░ 90%  4.5k / 5.0k tok · local
    oh-my-pi (omp) logs      1.0k tok · 18% of 24h · local
  ```
- Line counts: derive.ts 111, OverviewView.tsx 62 — all <200.

---

## Cycle 6 — `amana report` shows a fake "0%" bar for limitless windows

- **Status:** SHIPPED
- **Reference behavior:** A percent/bar means utilization of a limit. Without a
  configured limit there is no percentage to show (0% of what?). CLI analog of
  cycle 5's Overview fix.
- **Current amana behavior:** `report.ts::renderWindowLine` always renders
  `${bar(w.pct)} ${pct}%` even when the window has no `tokenLimit`, so every
  limitless window prints `░░░░░░░░░░   0%` — a meaningless empty bar.
- **Eligible:** Yes — local CLI render, no deps, files <200.
- **Done when:**
  1. `amana report` prints the bar + percent for a window ONLY when that window
     has a configured token limit; limitless windows show usage (+cost) with no
     bar/percent, consistent with the TUI Overview/Limits.
  2. Multi-window rendering (cycle 1) still holds.
  3. New tests: a limitless provider's report line has no `%`/bar; a
     token-limited window shows the bar + percent.
  4. `bun run typecheck` + `bun run build` clean; full `bun test` green; CLI
     smoke shows the cleaned-up output; files <200.

### Verdict: SHIPPED

Fix (implemented + verified in-session; FIXER subagent re-attempted this cycle
and failed again with 429 rate-limit — delegation still blocked):
- `src/report/report.ts` — `renderWindowLine` renders `${bar} ${pct}%` only when
  `w.tokenLimit !== undefined`; a limitless window returns head + `·` + usage
  tail (no bar/percent). Multi-window loop unchanged.
- Tests: `src/report/report.test.ts` (+2) — limitless line has no `%`/`░`/`█`
  but shows usage; a `window_token_limit` provider's line shows the bar + `%` +
  `X / Y tok`.

Evidence:
- `bun run typecheck` clean; `bun run build` → `built dist/amana`.
- `bun test` (20 amana files) → `160 pass, 0 fail`.
- CLI smoke (`amana report`):
  ```
  omp   [rolling 5h]   resets in 3h 13m   ·  169.0M tok $101.76
  claude-code   [rolling 5h]   resets in 3h 13m   ·  0 tok -
  claude-code   [weekly mon]   resets in 24h 13m   ·  106.8k tok $1.11
  ```
  (no more `░░░░░░░░░░ 0%`; weekly cost $1.11 reflects cycle-4 cache pricing.)
- Line count: report.ts 48 — <200.

---

## Cycle 7 — `graph --provider <aggregate-id>` returns an empty chart

- **Status:** SHIPPED
- **Reference behavior:** `--provider <id>` should scope the chart to that
  provider's usage, consistent with `report`/TUI (which key by log source +
  omp `provider` filter). Documented ids include `omp` and `claude-code`.
- **Current amana behavior (bug):** `graph.ts` filters `hourlyByProvider` by the
  raw event `provider` field. Aggregate source ids (`omp`, `claude-code`) never
  match a raw field, so `amana graph --provider claude-code` prints `0 tok` and
  a blank chart even when data exists (verified: `--provider anthropic` shows
  1479.9M while `--provider claude-code` shows 0). It also conflates omp- and
  claude-code-sourced `anthropic` events under one raw name.
- **Eligible:** Yes — reuses `windowSeries`/`windowUsage`/`sourcesFor`; local,
  no deps, files <200.
- **Done when:**
  1. `amana graph --provider <id>` scopes via `sourcesFor(id)` + the omp
     `provider` filter (like the TUI drill-in), so `--provider claude-code` /
     `--provider omp` show real data.
  2. The no-`--provider` aggregate view + `by provider` breakdown are unchanged.
  3. New test: the extracted `providerSeries` helper scopes `claude-code` and
     `anthropic` to their own sources (distinct totals, no cross-contamination).
  4. `bun run typecheck` + `bun run build` clean; full `bun test` green; CLI
     smoke shows a populated `--provider claude-code` chart; files <200.

### Verdict: SHIPPED

Fix (implemented + verified in-session; subagent path still 429-limited):
- `src/cli/graph.ts` — new exported `providerSeries(db, id, startMs, endMs, span)`
  scoping via `sourcesFor(id)` + `byId(id)?.ompProvider` (windowSeries +
  windowUsage), used by the `--provider` path. The no-`--provider` aggregate
  view + `by provider` breakdown are unchanged.
- Tests: `src/cli/graph.test.ts` (4) — claude-code vs omp-anthropic don't
  cross-contaminate, `omp` sums all omp-source events, buckets span the window
  and sum to total.

Evidence:
- `bun run typecheck` clean; `bun run build` → `built dist/amana`.
- `bun test` (21 amana files) → `164 pass, 0 fail`.
- CLI smoke (previously `0 tok` for both):
  ```
  token usage/hour · last 24h · omp · 1483.4M tok · $896.66
  token usage/hour · last 168h · claude-code · 106.8k tok · $1.11
  ```
- Line count: graph.ts 96 — <200.

---

## Cycle 8 — Claude Sonnet 3.7 missing from the price table ($0 computed cost)

- **Status:** SHIPPED
- **Reference behavior:** Anthropic prices Claude Sonnet 3.7 at $3/Mtok input,
  $15/Mtok output (same family as 3.5 Sonnet / Sonnet 4). Cost must reflect it.
- **Current amana behavior (bug):** `price.ts` has no `claude-3-7-sonnet`
  pattern, and its prefixes don't match it (`claude-3-5-sonnet`/`claude-sonnet-4`
  are not substrings of `claude-3-7-sonnet-…`). Verified: `cost("claude-3-7-
  sonnet-20250219", 1M, 1M)` → `undefined` while 3.5/4/4.5/opus-4.1/haiku-4.5
  all resolve. On the computed path (Claude Code, Claude-only) every Sonnet 3.7
  turn is costed at $0.
- **Eligible:** Yes — one price-table row, no deps, file <200 lines.
- **Done when:**
  1. `cost(\"claude-3-7-sonnet-*\", …)` prices at $3/$15 per Mtok (incl. the
     cache multipliers from cycle 4).
  2. New test asserts 3.7 Sonnet prices correctly and is no longer undefined.
  3. `bun run typecheck` + `bun run build` clean; full `bun test` green.

### Verdict: SHIPPED

Fix (implemented + verified in-session; delegation still 429-blocked, and a
one-line price-table change is inline-appropriate regardless):
- `src/price.ts` — added `{ pattern: "claude-3-7-sonnet", pinPerMtok: 3.0,
  poutPerMtok: 15.0 }` (ordered among the sonnet entries; no prefix shadows it).
- Tests: `src/price.test.ts` (+1) — 3.7 Sonnet prices $18 for 1M/1M and $3 for
  1M input.

Evidence:
- Pre-fix probe: `cost("claude-3-7-sonnet-20250219", 1M, 1M)` → `undefined`;
  post-fix → `18`.
- `bun run typecheck` clean; `bun run build` → `built dist/amana`.
- `bun test` (21 amana files) → `165 pass, 0 fail`.
- Line count: price.ts 60 — <200.

---

## Cycle 9 — Monthly cost cap showed the cap but not spend

- **Status:** SHIPPED
- **Reference behavior:** A cost budget is useful only if you see spend against
  it (`$spend / $cap`), like a provider billing dashboard.
- **Current amana behavior (bug):** After `amana limit set <id> --cost N`, the
  TUI Limits "monthly cost cap" row rendered `cap $N.00` with `pct:0` and NO
  gauge — no current spend, so you couldn't tell how close you were.
- **Eligible:** Yes — computes this-month cost from already-ingested events; no
  deps, files <200.
- **Done when:** the cost-cap row shows `$spend / $cap` with a gauge; spend =
  this calendar month's cost for the provider's sources; tests + captured
  render; typecheck/build/suite green; files <200.

### Verdict: SHIPPED

Fix (implemented + verified in-session; delegation still 429-blocked):
- `src/report/snapshot.ts` — `ProviderView` gains `monthCostUsed?: number`;
  `buildView` computes it (when a `monthly_cost` cap is set) as the cost over the
  current calendar month (`activeAt({type:"monthly",day:1})` + `windowUsage`),
  scoped to the provider's sources + omp `provider` filter.
- `src/tui/views/limitRows.ts` — the monthly-cost-cap row now renders
  `$spend / $cap` with a gauge (`frac = spend/cap`, `statusOf` color) instead of
  a bare `cap $N`. The drill-in (cycle 3) reuses these rows, so it benefits too.
- Tests: `src/tui/views/limitRows.test.ts` (+1) — asserts `snap.monthCostUsed`
  and the row's `gauge`/`detail`/`pct` ($6 spend of $10 cap → 60%).

Evidence:
- `bun run typecheck` clean; `bun run build` → `built dist/amana`.
- `bun test` (21 amana files) → `166 pass, 0 fail`.
- Render → `.pr-assets/limits-cost-cap.txt`:
  ```
  ● █████████████░░░░░░░ 64%  monthly cost cap · $6.40 / $10.00 · local
  ```
- Line counts: snapshot.ts 131, limitRows.ts 120 — all <200.

Non-goal noted: local monthly-cost-cap ALERTS (firing on cost thresholds) remain
out of scope — cycle 2 added token-cap alerts only. Candidate for a later cycle.

---

## Cycle 10 — Monthly cost caps never fired threshold alerts

- **Status:** SHIPPED
- **Reference behavior:** A configured cost budget should warn you as spend
  approaches it — the same threshold alerts token caps get (cycles 2 + 9).
- **Current amana behavior (bug):** `localAlertReports` (cycle 2) emitted only a
  token-budget limit, so `amana limit set <id> --cost N` produced no alert even
  at 100% of the cost cap. The monthly spend (cycle 9's `monthCostUsed`) was
  displayed but never evaluated for alerts.
- **Eligible:** Yes — reuses the snapshot's `monthCostUsed` + `checkAndFire`;
  local, no deps, files <200.
- **Done when:** a local provider with a `monthly_cost` cap fires a threshold
  alert when this month's spend crosses a threshold (deduped per month via the
  month reset); providers with both caps emit both limits; below-threshold spend
  is silent; tests + smoke; typecheck/build/suite green.

### Verdict: SHIPPED

Fix (implemented + verified in-session; delegation still 429-blocked):
- `src/alerts/local.ts` — builds a `limits[]` per local provider: a
  `local-token-budget` limit (as before) AND a `local-cost-cap` limit when
  `monthly_cost` is set (fraction = `monthCostUsed / cap`, `unit:"usd"`, window
  reset = `activeAt({type:"monthly",day:1}).nextReset` so dedup re-arms monthly).
  A report is emitted whenever either cap exists (providers with only a cost cap
  now alert too).
- Tests: `src/alerts/local.test.ts` (+3) — cost cap emits a limit + fires at 90%;
  both caps emit both limit ids; below-threshold spend is silent. Cycle-2 token
  tests still pass.

Evidence:
- `bun run typecheck` clean; `bun run build` → `built dist/amana`.
- `bun test` (21 amana files) → `169 pass, 0 fail`.
- End-to-end smoke (mirrors useRefresh step 5): $9.50 of $10 cap →
  ```
  fired: 1
  banner: ⚠ claude-code local monthly cost cap at 95% (≥90%)
  second call (dedup): 0
  ```
- Line count: local.ts 63 — <200.

---

## Cycle 11 — `report` smeared the monthly cost cap across every window line

- **Status:** SHIPPED
- **Reference behavior:** A window's cost is that window's cost; a monthly budget
  is compared against the month's spend — not against a 5-hour or weekly slice.
- **Current amana behavior (bug):** `renderWindowLine` used `costStr(prov, ...)`,
  which appends `/ $<monthly cap>` to EVERY window. Verified with
  `limit set claude-code --cost 20`:
  ```
  claude-code   [rolling 5h]   …  ·  0 tok $0.00 / $20.00
  claude-code   [weekly mon]   …  ·  106.8k tok $1.11 / $20.00
  ```
  i.e. a 5-hour/weekly cost compared to a monthly budget.
- **Eligible:** Yes — local render; reuses cycle-9 `monthCostUsed`; files <200.
- **Done when:** per-window lines show the window's OWN cost (no cap); a single
  `[monthly cost]` line shows `$spend / $cap` (this month's spend) with a bar;
  dead `costStr`/`usedStr` removed; tests + smoke; typecheck/build/suite green.

### Verdict: SHIPPED

Fix (implemented + verified in-session; delegation still 429-blocked):
- `src/report/report.ts` — per-window cost is now the window's own
  (`$X`/`-`); new `renderCostLine` adds one `[monthly cost]` line per provider
  with a `monthly_cost` cap (`$spend / $cap` + bar, spend = cycle-9
  `monthCostUsed`). `renderWindowLine` no longer takes `prov`.
- `src/report/format.ts` — removed now-dead `costStr` and `usedStr` (the latter
  orphaned since cycle 1's `windowUsed`) and their unused type imports.
- Tests: `src/report/report.test.ts` (+1) — a window line shows its own cost
  (recent-only $5.00) with no `/ $20`, while the `[monthly cost]` line shows the
  full month spend `$8.00 / $20.00`.

Evidence:
- `bun run typecheck` clean; `bun run build` → `built dist/amana`.
- `bun test` (21 amana files) → `170 pass, 0 fail`.
- CLI smoke:
  ```
  claude-code   [rolling 5h]   resets in 2h 56m   ·  0 tok -
  claude-code   [weekly mon]   resets in 23h 56m   ·  106.8k tok $1.11
  claude-code   [monthly cost]   █░░░░░░░░░   6%  ·  $1.11 / $20.00
  ```
- Line counts: report.ts 61, format.ts 36 — all <200.

---

## Cycle 12 — Settings help text claimed alerts fire only on "a live limit"

- **Status:** SHIPPED
- **Reference behavior:** In-app help must match actual behavior. After cycles 2
  and 10, alerts fire on live quota AND locally-configured token/cost caps.
- **Current amana behavior (bug):** `SettingsView` printed "fires when a live
  limit crosses a threshold", telling users they must log in for alerts — false
  since cycle 2 (local token caps) and cycle 10 (local cost caps).
- **Eligible:** Yes — in-app text; local; file <200.
- **Done when:** the help text credits configured caps as well as live quota; a
  render test guards it; typecheck/build/suite green.

### Verdict: SHIPPED

Fix (implemented + verified in-session; also a diminishing-returns cleanup — the
big structural gaps are closed):
- `src/tui/views/SettingsView.tsx` — help text now reads "fires when any limit —
  live quota or a configured cap — crosses a threshold · saved to config.toml".
- Tests: `src/tui/views/SettingsView.test.tsx` (2) — asserts the text credits
  "configured cap" and no longer says "a live limit crosses"; setting rows present.

Evidence:
- `bun run typecheck` clean; `bun run build` → `built dist/amana`.
- `bun test` (22 amana files) → `172 pass, 0 fail`.
- Render → `.pr-assets/settings-view.txt`:
  ```
  alerts
  fires when any limit — live quota or a configured cap — crosses a threshold · saved to config.toml
  › Alerts enabled          ● on
  ```
- Line count: SettingsView.tsx 55 — <200.

---

## Loop retrospective (after 12 cycles)

12 gaps shipped, 172 tests green, every file <200 lines, zero new deps. The
high-value structural work is done — cost is cache-accurate and per-model
correct; local providers are first-class across report/Overview/Limits/drill-in;
alerts fire on token AND cost caps; cost caps show spend and alert; bars mean
utilization only where a real limit exists; `graph --provider` resolves
aggregate ids. Remaining known items are minor (e.g. per-provider $ on the
Overview rows). Recommend pausing the loop or raising the bar to net-new
features rather than parity fixes.

Standing caveat across all 12 cycles: the FIXER/VERIFIER subagents were 429
rate-limited every attempt, so cycles ran in-session rather than via the
template's fan-out.

---

## User request — show API keys in the clear (no masked input)

- **Status:** SHIPPED (direct user instruction, not a loop-selected gap)
- **Ask:** "For all of the api key inputs, do not hide the api key, keep it open."
- **Finding:** Only one input was masked — the CLI **admin key** via
  `promptPassword` (raw-mode, no echo) in `adminKeyLogin`. The TUI `ApikeyView`
  already rendered `API key: <key>` in the clear, and the CLI regular API key
  (`apiKeyLogin`) already used the echoing `promptText`.
- **Change:**
  - `src/auth/loginFlows.ts` — `adminKeyLogin` reads via `promptText` (visible);
    import updated.
  - `src/cli/prompt.ts` — removed the now-dead `promptPassword`.
- **Evidence:** `grep setRawMode|promptPassword|Bun.password` → none;
  `typecheck`+`build` clean; `bun test` 172 pass/0 fail; TUI render
  `.pr-assets/apikey-input.txt` shows the full key
  (`API key: sk-ant-EXAMPLE-1234567890▌`).

---

## User request (cont.) — real cause was PASTE not working in the TUI key field

- **Status:** SHIPPED
- **Clarification:** The user's "keep the api key open" reports (×5) turned out
  NOT to be about masking — the key always echoed. The actual symptom was "I
  can't paste my key in that field, it shows empty." Root cause: the TUI input
  gate `isPrintable` required `input.length === 1`, and Ink delivers a clipboard
  paste as ONE multi-character chunk → the whole paste was dropped. Typing one
  char at a time worked, which is why every earlier test/render/live-CLI check
  passed (none pasted).
- **Fix:**
  - `src/tui/login/useProviderLogin.ts` — replaced `isPrintable` with
    `printableChunk`, which accepts a multi-char paste (and single char), strips
    control keys + bracketed-paste markers; applied to the API-key field and the
    provider filter.
  - `src/tui/login/useProviderLogin.test.ts` — 5 tests (single char, pasted key
    intact, bracketed-paste stripped, control keys ignored, stray bytes filtered).
- **Evidence:** live TUI paste →
  `API key: sk-PASTED-KEY-abcdef123456▌` (pre-fix frame was empty `API key: ▌`);
  `typecheck`+`build` clean; `bun test` 177 pass / 0 fail.
