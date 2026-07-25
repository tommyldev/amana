/**
 * Generate terminal-style SVG screenshots of the TUI populated with realistic
 * sample data. Boots the real <App> against a temp SQLite DB + config, mocks
 * the network/ingest/alert side effects, drives the dashboard via stdin, and
 * converts each captured ANSI frame into an SVG via ../scripts/ansi-to-svg.
 *
 *   bun scripts/shoot.ts
 *
 * Output: docs/img/*.svg
 */
import { spyOn } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

process.env.FORCE_COLOR = "1";
const dataDir = mkdtempSync(join(tmpdir(), "amana-shoot-"));
process.env.ATOP_CONFIG_DIR = dataDir;
process.env.ATOP_DATA_DIR = dataDir;
process.env.ATOP_OMP_DIR = join(dataDir, "omp");
process.env.ATOP_CLAUDE_DIR = join(dataDir, "claude");

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "docs", "img");
mkdirSync(outDir, { recursive: true });

// Dynamic imports are required: App/ink/paths read FORCE_COLOR and ATOP_* env
// at module-load time, so env must be set (above) before these execute.
const { resolvePaths } = await import("../src/config/paths.ts");
const { loadConfig, saveConfig } = await import("../src/config/config.ts");
const { defaultConfig } = await import("../src/config/defaults.ts");
const { openDb } = await import("../src/db/db.ts");
const { insertEvents } = await import("../src/db/usage.ts");
const { App } = await import("../src/tui/App.tsx");
const orchestrator = await import("../src/usage/orchestrator.ts");
const syncMod = await import("../src/ingest/sync.ts");
const engine = await import("../src/alerts/engine.ts");
const notifyMod = await import("../src/alerts/notify.ts");
const { render: inkRender } = await import("ink");
const React = await import("react");
const { frameToSvg } = await import("./ansi-to-svg.ts");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface Seed {
  id: string;
  source: string;
  provider: string;
  models: string[];
  dailyTarget: number;
}

const SEEDS: Seed[] = [
  { id: "claude-code", source: "claude-code", provider: "claude-code", models: ["claude-sonnet-4.5", "claude-opus-4.1", "claude-haiku-4.5"], dailyTarget: 5200 },
  { id: "openai-codex", source: "omp", provider: "openai-codex", models: ["gpt-5-codex"], dailyTarget: 950000 },
  { id: "anthropic", source: "omp", provider: "anthropic", models: ["claude-sonnet-4.5", "claude-haiku-4.5"], dailyTarget: 34000 },
  { id: "zai", source: "omp", provider: "zai", models: ["glm-4.6"], dailyTarget: 11000 },
];

const RATE: Record<string, number> = {
  "claude-sonnet-4.5": 3, "claude-opus-4.1": 15, "claude-haiku-4.5": 0.25,
  "gpt-5-codex": 1.5, "glm-4.6": 0.6,
};

const HOUR_WEIGHT = [
  0, 0, 0, 0, 0, 0, 0.2, 0.5, 0.9, 1.0, 0.95, 0.8,
  0.7, 0.85, 1.0, 0.9, 0.75, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0.05,
];

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildEvents(now: number) {
  const rng = mulberry32(20260725);
  const rows = [];
  const todayStart = Math.floor(now / DAY) * DAY;
  for (let dayAgo = 6; dayAgo >= 0; dayAgo--) {
    const dayStart = todayStart - dayAgo * DAY;
    const isToday = dayAgo === 0;
    for (const seed of SEEDS) {
      const target = isToday ? seed.dailyTarget : Math.round(seed.dailyTarget * (0.6 + rng() * 0.7));
      let placed = 0;
      const weightSum = HOUR_WEIGHT.reduce((a, b) => a + b, 0);
      for (let h = 0; h < 24 && placed < target; h++) {
        const w = HOUR_WEIGHT[h]!;
        if (w <= 0) continue;
        const eventsThisHour = w > 0.8 ? 2 : 1;
        for (let e = 0; e < eventsThisHour && placed < target; e++) {
          const model = seed.models[Math.floor(rng() * seed.models.length)]!;
          const share = (w / weightSum) / eventsThisHour;
          const chunk = Math.max(1, Math.round(target * share * (0.6 + rng() * 0.8)));
          placed += chunk;
          const prompt = Math.round(chunk * (0.55 + rng() * 0.2));
          const completion = chunk - prompt;
          const ts = dayStart + h * HOUR + Math.floor(rng() * HOUR);
          const cost = Number(((chunk / 1_000_000) * (RATE[model] ?? 1)).toFixed(4));
          rows.push({
            source: seed.source,
            source_message_id: `${seed.provider}-${ts}-${e}`,
            timestamp_ms: ts,
            provider: seed.provider,
            model,
            prompt_tokens: prompt,
            completion_tokens: completion,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            total_tokens: chunk,
            cost_usd: cost,
            cost_origin: "computed",
          });
        }
      }
    }
  }
  return rows;
}

const paths = resolvePaths();
const now = Date.now();

const cfg = defaultConfig();
for (const p of cfg.providers) {
  p.enabled = ["claude-code", "anthropic", "zai", "openai-codex"].includes(p.id);
}
const lim = (id: string, l: { window_token_limit?: number; monthly_cost?: number }) => {
  const p = cfg.providers.find((x) => x.id === id);
  if (p) p.limits = { ...p.limits, ...l };
};
lim("claude-code", { window_token_limit: 5800 });
lim("openai-codex", { window_token_limit: 2_000_000 });
lim("anthropic", { window_token_limit: 80_000, monthly_cost: 5 });
saveConfig(paths.configFile, cfg);

const db = openDb(paths.dbFile);
insertEvents(db, buildEvents(now));
const fetchSpy = spyOn(orchestrator, "fetchAll").mockImplementation(() => Promise.resolve({ reports: [], errors: [] }));
const syncSpy = spyOn(syncMod, "runSync").mockImplementation(() => Promise.resolve([]));
const alertSpy = spyOn(engine, "checkAndFire").mockImplementation(() => []);
const notifySpy = spyOn(notifyMod, "notify").mockImplementation(() => {});

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

class Stdout extends EventEmitter {
  frames: string[] = [];
  private last = "";
  constructor(public columns: number, public rows: number) { super(); }
  write = (frame: string): void => { this.frames.push(frame); this.last = frame; };
  lastFrame = (): string => this.last;
}
class Stdin extends EventEmitter {
  isTTY = true;
  private data: string | null = null;
  write = (data: string): void => {
    this.data = data;
    this.emit("readable");
    this.emit("data", data);
  };
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  read = (): string | null => {
    const data = this.data;
    this.data = null;
    return data;
  };
}

function mount(tree: React.ReactElement, columns: number, rows: number) {
  const stdout = new Stdout(columns, rows);
  const stdin = new Stdin();
  const instance = inkRender(tree, { stdout, stdin, debug: true, exitOnCtrlC: false, patchConsole: false });
  return { stdin, lastFrame: stdout.lastFrame, unmount: () => { instance.unmount(); instance.cleanup(); } };
}

interface Shot {
  name: string;
  title: string;
  rows: number;
  keys: string[];
}

const SHOTS: Shot[] = [
  { name: "overview", title: "amana — Overview", rows: 30, keys: ["2"] },
  { name: "overview-7d", title: "amana — Overview · 7d", rows: 30, keys: ["2", "t", "t"] },
  { name: "limits", title: "amana — Limits", rows: 26, keys: ["1"] },
  { name: "drill-in", title: "amana — Provider detail", rows: 30, keys: ["2", "\r"] },
  { name: "settings", title: "amana — Settings", rows: 16, keys: ["3"] },
];

for (const shot of SHOTS) {
  const { lastFrame, stdin, unmount } = mount(
    React.createElement(App, { db, cfg, dataDir: paths.dataDir, configFile: paths.configFile }),
    100,
    shot.rows,
  );
  await delay(90);
  for (const k of shot.keys) {
    stdin.write(k);
    await delay(45);
  }
  const frame = lastFrame();
  writeFileSync(join(outDir, `${shot.name}.svg`), frameToSvg(frame, { cols: 100, rows: shot.rows, title: shot.title }));
  unmount();
}
fetchSpy.mockRestore();
syncSpy.mockRestore();
alertSpy.mockRestore();
notifySpy.mockRestore();
db.close();
process.stdout.write(`wrote ${SHOTS.length} SVGs to ${outDir}\n`);
