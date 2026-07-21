# amana parity loop prompt

You run an autonomous loop that closes the gap between **amana** (a local-first,
single-binary Bun CLI + Ink TUI that monitors AI token/cost usage and limits
across many providers) and the fidelity of **each provider's own quota/billing
dashboard** plus the feel of best-in-class local monitors (oh-my-pi's usage
screen, ccusage). Each cycle: find the single highest-value gap yourself, spawn
an agent to fix it, then spawn a separate agent to verify it against a strict
bar. Work autonomously — never ask me questions; assume, note it, keep going.

FIND YOUR OWN GAPS (do not trust any backlog/roadmap doc or the README table —
they're stale):

- Actually run the app: launch the TUI (`bun src/index.ts`) and exercise every
  surface — Overview, Provider drill-in, Settings/alerts — and run every CLI
  path (`report`, `sync`, `usage [--json] [--provider]`, `graph`, `login`,
  `accounts`, `window set`, `limit set`, `alerts set|test`). Where a live login
  isn't available, render TUI components with `ink-testing-library` and drive
  CLI commands against a temp `ATOP_DATA_DIR`/`ATOP_CONFIG_DIR`.
- Cross-read `src/{tui,usage,ingest,alerts,report,cli,auth,window,config,db}`,
  `src/registry.ts`, and `src/price.ts` to see what's really implemented vs
  faked/hardcoded/missing (e.g. providers in `registry.ts` with no real
  `usage/providers/*` fetcher, placeholder reset timers, wrong window math,
  stale prices).
- Compare each surface to (a) what that provider's own dashboard actually
  reports and (b) how a great monitor behaves; pick the gap (missing feature,
  half-built flow, wrong number, or bug) whose fix most improves everyday
  accuracy and feel.
- Verify the gap is real in code before committing to it (not already shipped).
- Track picks in `docs/parity-loop-log.md` (create if absent) so you never
  rediscover the same gap; log each as SHIPPED / BLOCKED / SKIPPED.

A gap is INELIGIBLE (skip it) if it can't respect the app's hard constraints:
local-first (nothing leaves the machine except the provider API calls the user
opted into), no server/backend and no background daemon (refresh happens only on
the TUI timer or `r`), single self-contained Bun binary (`bun:sqlite`, no new
heavy runtime deps — add deps sparingly, maintained within a year,
version-locked), read-only against providers (amana observes quota; it never
changes it), SQLite schema + `config.toml` stay back-compatible with the
existing/Rust build, credentials stay in `credentials.json` (`0600`), and every
module stays under 200 lines. That rules out things like a hosted sync service,
a resident polling daemon, real-time push/websocket streams, provider write
actions, scraping providers that expose no usage endpoint, or bundling a
browser/DB engine.

CYCLE:

1. SELECT — Pick ONE eligible gap. State the reference behavior it matches (the
   provider dashboard fact or the best-in-class monitor behavior), the current
   amana behavior, and a crisp "Done when" acceptance line you write.
2. FIX — Spawn a FIXER agent: implement it; reuse existing patterns (no second
   convention — wire the existing `registry.ts` `ProviderDef`, `usage/`
   fetcher/orchestrator, `window/`, `alerts/`, `price.ts`, and `tui/theme.ts`
   primitives where they exist); keep every file <200 lines; add `bun test`
   (vitest-style) tests that fail on a plausible bug; add a CLI/TUI smoke path
   if there's a user flow. No stubs/TODOs, no scope creep, no error suppression,
   no unlocked deps.
3. VERIFY — Spawn a DIFFERENT agent that runs this self-checking loop until it
   meets the bar or is provably blocked (it gathers evidence and re-dispatches
   scoped fixers; it does NOT grade its own code):

   Criteria (score 1-10; ≥8 REQUIRES pasted evidence, else cap at 5):
   a) Does exactly what "Done when" says — nothing less, no scope creep.
   b) `bun run typecheck` + `bun run build` clean.
   c) New `bun test` cases assert real behavior; full `bun test` green.
   d) UI (if the change is visual/TUI): actually run it — launch
      `bun src/index.ts` against a temp `ATOP_DATA_DIR`/`ATOP_CONFIG_DIR` and/or
      render the component via `ink-testing-library`, and dump the rendered
      frame(s) (ANSI/text `lastFrame()` capture) to `.pr-assets/`. Then check:
        - Cohesion: matches the rest of the TUI's design system — `theme.ts`
          colors (`statusColor`, heat ramp, per-provider `PALETTE`), existing
          widgets (`LineGauge`, `UsageChart`, `Table`, `Tabs`, `Footer`),
          spacing and box borders — not a new look.
        - Legibility/contrast: no text uses a color that vanishes against its
          box/background (e.g. `gray` on a dim border, color-on-same-color);
          every stacked Ink `<Box>` and status must stay distinguishable;
          bars/labels don't collide when the terminal is narrow.
        - All states present: empty (no accounts / no data yet), loading
          (fetching live usage), error (auth expired / API failure /
          rate-limited), and stale/optimistic (last-known values while
          refreshing).
      No captured render → this criterion cannot exceed 5.
   e) Respects the hard constraints above; reuses patterns; no non-goal violated
      (still local-first, no daemon, schema/config back-compat, files <200
      lines).
   f) No regressions: full `bun test` stays green; the affected CLI commands
      still run cleanly against a temp dir; no new uncaught exceptions or
      unhandled rejections in a TUI/CLI run.

   Loop: PLAN one step → DO (gather evidence / dispatch a scoped fixer for the
   single weakest criterion) → VERIFY (score all six with evidence, list what's
   weak, be brutally honest) → DECIDE: all ≥8 AND "Done when" literally met AND
   evidence attached → print "FINAL". Else "ITERATING", fix the lowest score
   first, repeat. Max 5 passes; if still short, print "BLOCKED" + the reason.

4. RECORD — Append to `docs/parity-loop-log.md`: gap, verdict, evidence (command
   tails + captured-render path).
5. NEXT — Print "gap → verdict" and start the next cycle.
