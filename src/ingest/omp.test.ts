/**
 * Tests for src/ingest/omp.ts. Ports source/omp/tests.rs:
 *   1. parseOmpLine — verifies a real omp session line (assistant message
 *      with usage) becomes the expected UsageEventRow.
 *   2. ingestOmp end-to-end on a tmp directory: writes a 2-message JSONL
 *      fixture (one user msg that should be skipped, one assistant msg with
 *      usage that should be ingested) and checks the inserted count, then
 *      calls ingestOmp a second time and confirms 0 new rows.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../db/db.ts";
import { parseOmpLine, ingestOmp } from "./omp.ts";

let tmp: string;
let ompRoot: string;
let prevEnv: string | undefined;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "atop-omp-"));
  ompRoot = join(tmp, "sessions", "2026-06-27");
  mkdirSync(ompRoot, { recursive: true });
  prevEnv = process.env.ATOP_OMP_DIR;
  process.env.ATOP_OMP_DIR = ompRoot;
  dbPath = join(tmp, "atop.db");
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.ATOP_OMP_DIR;
  else process.env.ATOP_OMP_DIR = prevEnv;
  rmSync(tmp, { recursive: true, force: true });
});

test("parse_real_omp_line: real assistant message with usage", () => {
  const line =
    `{"type":"message","id":"bf8a1e10","message":{` +
    `"role":"assistant","model":"MiniMax-M2.7-highspeed","provider":"minimax-code",` +
    `"usage":{"input":22947,"output":46,"cacheRead":0,"cacheWrite":0,"totalTokens":22993,` +
    `"reasoningTokens":37,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},` +
    `"timestamp":1778936729894,"stopReason":"toolUse","duration":1234,"ttft":56}}`;
  const row = parseOmpLine(line);
  expect(row).not.toBeNull();
  expect(row!.provider).toBe("minimax-code");
  expect(row!.model).toBe("MiniMax-M2.7-highspeed");
  expect(row!.total_tokens).toBe(22993);
  expect(row!.source).toBe("omp");
  expect(row!.timestamp_ms).toBe(1778936729894);
  expect(row!.cost_origin).toBe("logged");
});

test("parseOmpLine: skips non-message entries and non-assistant roles", () => {
  expect(parseOmpLine(`{"type":"summary","id":"x"}`)).toBeNull();
  expect(parseOmpLine(`{"type":"message","id":"x","message":{"role":"user","content":"hi"}}`)).toBeNull();
  expect(parseOmpLine(`{"type":"message","id":"x"}`)).toBeNull();
  expect(parseOmpLine(`not-json`)).toBeNull();
});

test("parseOmpLine: rfc3339 timestamp and cost.total", () => {
  const line =
    `{"type":"message","id":"y","message":{` +
    `"role":"assistant","model":"claude-3-5-sonnet-20240620","provider":"anthropic",` +
    `"usage":{"input":100,"output":50,"cacheRead":0,"cacheWrite":0,` +
    `"cost":{"total":0.0012}},"timestamp":"2026-06-27T10:00:00Z"}}`;
  const row = parseOmpLine(line)!;
  expect(row.timestamp_ms).toBe(Date.UTC(2026, 5, 27, 10, 0, 0));
  expect(row.cost_usd).toBeCloseTo(0.0012, 9);
  expect(row.total_tokens).toBe(150);
});

test("parseOmpLine: prefers the top-level event timestamp over nested/now", () => {
  const line =
    `{"type":"message","id":"z","timestamp":"2026-07-16T14:36:47.240Z","message":{` +
    `"role":"assistant","model":"MiniMax-M3","provider":"minimax-code",` +
    `"usage":{"input":10,"output":5,"cacheRead":0,"cacheWrite":0,"cost":{"total":0}}}}`;
  const row = parseOmpLine(line)!;
  expect(row.timestamp_ms).toBe(Date.parse("2026-07-16T14:36:47.240Z"));
});

test("ingestOmp: ingests one assistant message; second pass is a no-op", async () => {
  const file = join(ompRoot, "a.jsonl");
  writeFileSync(
    file,
    [
      `{"type":"message","id":"x","message":{"role":"user","content":"hi"}}`,
      `{"type":"message","id":"y","message":{"role":"assistant","model":"claude-3-5-sonnet-20240620",` +
        `"provider":"anthropic","usage":{"input":100,"output":50,"cacheRead":0,"cacheWrite":0,` +
        `"cost":{"total":0.0012}},"timestamp":"2026-06-27T10:00:00Z"}}`,
    ].join("\n") + "\n",
  );

  const db = openDb(dbPath);
  try {
    const out = await ingestOmp(db, false);
    expect(out.inserted).toBe(1);
    expect(out.status).toBe("ok");

    const out2 = await ingestOmp(db, false);
    expect(out2.inserted).toBe(0);
  } finally {
    db.close();
  }
});

test("ingestOmp: full=true resets the cursor and re-reads", async () => {
  const file = join(ompRoot, "a.jsonl");
  writeFileSync(
    file,
    `{"type":"message","id":"y","message":{"role":"assistant","model":"m",` +
      `"provider":"p","usage":{"input":1,"output":2,"cacheRead":0,"cacheWrite":0},` +
      `"timestamp":1778936729894}}\n`,
  );

  const db = openDb(dbPath);
  try {
    expect((await ingestOmp(db, false)).inserted).toBe(1);
    expect((await ingestOmp(db, false)).inserted).toBe(0);
    // full re-reads from offset 0 and re-inserts via INSERT OR IGNORE; db
    // count of distinct (source,source_message_id) rows stays at 1 but the
    // inserted return is 0 because the unique constraint suppresses dupes.
    expect((await ingestOmp(db, true)).inserted).toBe(0);
  } finally {
    db.close();
  }
});