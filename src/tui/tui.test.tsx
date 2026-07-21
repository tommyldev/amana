import { test, expect, beforeAll } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "atop-tui-"));
process.env.ATOP_CONFIG_DIR = dir;
process.env.ATOP_DATA_DIR = dir;
process.env.ATOP_OMP_DIR = join(dir, "omp");
process.env.ATOP_CLAUDE_DIR = join(dir, "claude");

const { resolvePaths } = await import("../config/paths.ts");
const { loadConfig } = await import("../config/config.ts");
const { openDb } = await import("../db/db.ts");
const { insertEvents } = await import("../db/usage.ts");
const { App } = await import("./App.tsx");

const paths = resolvePaths();
const cfg = loadConfig(paths.configFile);
const db = openDb(paths.dbFile);

beforeAll(() => {
  const now = Date.now();
  const rows = Array.from({ length: 3 }, (_, i) => ({
    source: "omp",
    source_message_id: `t${i}`,
    timestamp_ms: now - i * 3_600_000,
    provider: "anthropic",
    model: "claude-opus-4",
    prompt_tokens: 1000,
    completion_tokens: 500,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    total_tokens: 1500,
    cost_usd: 0.1,
    cost_origin: "logged",
  }));
  insertEvents(db, rows);
});

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

test("App boots on the Limits view with all three tabs", async () => {
  const { lastFrame, unmount } = render(
    <App db={db} cfg={cfg} dataDir={paths.dataDir} configFile={paths.configFile} />,
  );
  await delay(60);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("Limits");
  expect(frame).toContain("Overview");
  expect(frame).toContain("Settings");
  expect(frame).toContain("limits");
  unmount();
});

test("tabs: 2 → Overview, 3 → Settings, 1 → Limits", async () => {
  const { lastFrame, stdin, unmount } = render(
    <App db={db} cfg={cfg} dataDir={paths.dataDir} configFile={paths.configFile} />,
  );
  await delay(60);

  stdin.write("2");
  await delay(30);
  expect(lastFrame() ?? "").toContain("last 24h");

  stdin.write("3");
  await delay(30);
  const settings = lastFrame() ?? "";
  expect(settings).toContain("Alerts enabled");
  expect(settings).toContain("Alert thresholds");

  stdin.write("1");
  await delay(30);
  expect(lastFrame() ?? "").toContain("limits");
  unmount();
});

test("pressing p opens the provider login list", async () => {
  const { lastFrame, stdin, unmount } = render(
    <App db={db} cfg={cfg} dataDir={paths.dataDir} configFile={paths.configFile} />,
  );
  await delay(60);
  stdin.write("p");
  await delay(30);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("Providers");
  expect(frame).toContain("type to filter");
  expect(frame).toContain("Anthropic");
  unmount();
});

test("typing filters the list and Enter opens a provider's add-actions", async () => {
  const { lastFrame, stdin, unmount } = render(
    <App db={db} cfg={cfg} dataDir={paths.dataDir} configFile={paths.configFile} />,
  );
  await delay(60);
  stdin.write("p");
  await delay(20);
  for (const ch of "codex") stdin.write(ch);
  await delay(30);
  const filtered = lastFrame() ?? "";
  expect(filtered).toContain("filter: codex");
  expect(filtered).not.toContain("Groq");

  stdin.write("\r");
  await delay(30);
  const detail = lastFrame() ?? "";
  expect(detail).toContain("Add account via OAuth");
  expect(detail).toContain("Add account via API key");
  expect(detail).toContain("remove account");
  unmount();
});

test("Esc closes the provider overlay back to the dashboard", async () => {
  const { lastFrame, stdin, unmount } = render(
    <App db={db} cfg={cfg} dataDir={paths.dataDir} configFile={paths.configFile} />,
  );
  await delay(60);
  stdin.write("p");
  await delay(20);
  expect(lastFrame() ?? "").toContain("Providers");
  stdin.write("\u001B");
  await delay(30);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("limits");
  expect(frame).not.toContain("type to filter");
  unmount();
});

test("API-key entry stays in the TUI: visible key + non-blank guard", async () => {
  const { lastFrame, stdin, unmount } = render(
    <App db={db} cfg={cfg} dataDir={paths.dataDir} configFile={paths.configFile} />,
  );
  await delay(60);
  stdin.write("p");
  await delay(20);
  for (const ch of "zai") stdin.write(ch);
  await delay(20);
  stdin.write("\r"); // list → detail
  await delay(20);
  stdin.write("\r"); // select "Add via API key"
  await delay(20);
  const input = lastFrame() ?? "";
  expect(input).toContain("add API key"); // in-TUI, not a terminal drop
  expect(input).toContain("API key:");

  stdin.write("\r"); // blank submit
  await delay(20);
  expect(lastFrame() ?? "").toContain("API key cannot be blank");

  for (const ch of "sk-xyz-123") stdin.write(ch);
  await delay(20);
  expect(lastFrame() ?? "").toContain("sk-xyz-123"); // shown, not masked
  unmount();
});

test("API-key field accepts a pasted chunk (plain + bracketed paste)", async () => {
  const { lastFrame, stdin, unmount } = render(
    <App db={db} cfg={cfg} dataDir={paths.dataDir} configFile={paths.configFile} />,
  );
  await delay(60);
  stdin.write("p");
  await delay(20);
  for (const ch of "zai") stdin.write(ch);
  await delay(20);
  stdin.write("\r"); // list → detail
  await delay(20);
  stdin.write("\r"); // select "Add via API key"
  await delay(20);

  // A clipboard paste arrives as ONE multi-character chunk, not char-by-char.
  stdin.write("sk-plain-ABCDEF123456");
  await delay(20);
  expect(lastFrame() ?? "").toContain("sk-plain-ABCDEF123456");

  // Bracketed-paste wrapper must be stripped, its content kept.
  stdin.write("\u001b[200~-and-BRACKETED\u001b[201~");
  await delay(20);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("-and-BRACKETED");
  expect(frame).not.toContain("200~");
  unmount();
});
