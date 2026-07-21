/**
 * Tests for src/ingest/claudeCode.ts. Ports source/claude_code/tests.rs:
 *   1. parseClaudeCodeLine — verifies a real Claude Code assistant line
 *      becomes a UsageEventRow with provider="anthropic" and
 *      cost_origin="computed".
 *   2. ingestClaudeCode end-to-end: writes three assistant lines (same
 *      uuid "u1" with growing output_tokens, then uuid "u2") and confirms
 *      the upsert keeps the MAX of completion_tokens while leaving distinct
 *      uuids intact.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../db/db.ts";
import { windowUsage } from "../db/usage.ts";
import { parseClaudeCodeLine, ingestClaudeCode } from "./claudeCode.ts";

let tmp: string;
let ccRoot: string;
let prevEnv: string | undefined;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "atop-cc-"));
  ccRoot = join(tmp, "projects", "abc");
  mkdirSync(ccRoot, { recursive: true });
  prevEnv = process.env.ATOP_CLAUDE_DIR;
  process.env.ATOP_CLAUDE_DIR = ccRoot;
  dbPath = join(tmp, "atop.db");
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.ATOP_CLAUDE_DIR;
  else process.env.ATOP_CLAUDE_DIR = prevEnv;
  rmSync(tmp, { recursive: true, force: true });
});

test("parseClaudeCodeLine: real assistant line", () => {
  const line =
    `{"type":"assistant","uuid":"u1","timestamp":"2026-06-27T10:00:00Z","message":{` +
    `"role":"assistant","model":"claude-3-5-sonnet-20240620",` +
    `"usage":{"input_tokens":100,"output_tokens":1,` +
    `"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}`;
  const row = parseClaudeCodeLine(line)!;
  expect(row.source).toBe("claude-code");
  expect(row.provider).toBe("anthropic");
  expect(row.model).toBe("claude-3-5-sonnet-20240620");
  expect(row.completion_tokens).toBe(1);
  expect(row.total_tokens).toBe(101);
  expect(row.cost_origin).toBe("computed");
  expect(row.cost_usd).toBeCloseTo(
    (100 / 1_000_000) * 3.0 + (1 / 1_000_000) * 15.0,
    12,
  );
  expect(row.timestamp_ms).toBe(Date.UTC(2026, 5, 27, 10, 0, 0));
});

test("parseClaudeCodeLine: cache tokens are included in computed cost", () => {
  const line =
    `{"type":"assistant","uuid":"c1","timestamp":"2026-06-27T10:00:00Z","message":{` +
    `"role":"assistant","model":"claude-3-5-sonnet-20240620",` +
    `"usage":{"input_tokens":1000,"output_tokens":500,` +
    `"cache_read_input_tokens":1000000,"cache_creation_input_tokens":200000}}}`;
  const row = parseClaudeCodeLine(line)!;
  expect(row.cache_read_tokens).toBe(1_000_000);
  expect(row.cache_write_tokens).toBe(200_000);
  // input 1000@$3 + output 500@$15 + cacheRead 1M@(3*0.1) + cacheWrite 200k@(3*1.25)
  const expected =
    (1000 / 1_000_000) * 3.0 +
    (500 / 1_000_000) * 15.0 +
    (1_000_000 / 1_000_000) * 3.0 * 0.1 +
    (200_000 / 1_000_000) * 3.0 * 1.25;
  expect(row.cost_usd).toBeCloseTo(expected, 9);
  // Cache-blind cost would omit the 0.3 + 0.75 cache terms.
  const blind = (1000 / 1_000_000) * 3.0 + (500 / 1_000_000) * 15.0;
  expect(row.cost_usd! - blind).toBeCloseTo(0.3 + 0.75, 9);
});

test("parseClaudeCodeLine: non-claude model → provider unknown", () => {
  const line =
    `{"type":"assistant","uuid":"u9","timestamp":"2026-06-27T10:00:00Z",` +
    `"message":{"role":"assistant","model":"some-other-model",` +
    `"usage":{"input_tokens":1,"output_tokens":1,` +
    `"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}`;
  const row = parseClaudeCodeLine(line)!;
  expect(row.provider).toBe("unknown");
});

test("parseClaudeCodeLine: skips non-assistant types and non-assistant roles", () => {
  expect(parseClaudeCodeLine(`{"type":"user","uuid":"x"}`)).toBeNull();
  expect(
    parseClaudeCodeLine(
      `{"type":"assistant","uuid":"x","message":{"role":"user","model":"claude-3","usage":{}}}`,
    ),
  ).toBeNull();
  expect(parseClaudeCodeLine(`not-json`)).toBeNull();
});

test("ingestClaudeCode: dedups streaming u1 and keeps MAX completion_tokens", async () => {
  const file = join(ccRoot, "a.jsonl");
  writeFileSync(
    file,
    [
      `{"type":"assistant","uuid":"u1","timestamp":"2026-06-27T10:00:00Z","message":{"role":"assistant",` +
        `"model":"claude-3-5-sonnet-20240620","usage":{"input_tokens":100,"output_tokens":1,` +
        `"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}`,
      `{"type":"assistant","uuid":"u1","timestamp":"2026-06-27T10:00:01Z","message":{"role":"assistant",` +
        `"model":"claude-3-5-sonnet-20240620","usage":{"input_tokens":100,"output_tokens":4200,` +
        `"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}`,
      `{"type":"assistant","uuid":"u2","timestamp":"2026-06-27T10:01:00Z","message":{"role":"assistant",` +
        `"model":"claude-3-5-sonnet-20240620","usage":{"input_tokens":50,"output_tokens":30,` +
        `"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}`,
    ].join("\n") + "\n",
  );

  const db = openDb(dbPath);
  try {
    const out = await ingestClaudeCode(db, false);
    expect(out.inserted).toBe(3);
    // MAX(u1.output=4200, u2.output=30)
    const agg = windowUsage(db, 0, Number.MAX_SAFE_INTEGER, ["claude-code"], undefined);
    expect(agg.completion).toBe(4200 + 30);
    // Exactly two distinct (source, source_message_id) rows survive dedup.
    const rows = db
      .query("SELECT source_message_id FROM usage_events WHERE source = ? ORDER BY source_message_id")
      .all("claude-code") as { source_message_id: string }[];
    expect(rows.map((r) => r.source_message_id)).toEqual(["u1", "u2"]);
  } finally {
    db.close();
  }
});