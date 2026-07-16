/**
 * Incremental JSONL tailing for log-based ingestion sources.
 *
 * Mirrors the Rust process_file() loop in source/omp/mod.rs and
 * source/claude_code/mod.rs: walk a directory recursively for `*.jsonl`
 * files, read only the bytes after the stored offset, parse lines into
 * UsageEventRow candidates, and write the new offset+mtime back. Malformed
 * lines are skipped, never fatal. A missing directory returns empty results
 * rather than an error. A file that has shrunk past the stored offset is
 * re-read from byte 0 (the Rust `offset > size` guard).
 */
import { open } from "node:fs/promises";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { UsageEventRow } from "../db/types.ts";
import { getSync } from "../db/syncState.ts";

export interface ScanOptions {
  /** Ingestion source key in the sync_state table (e.g. "omp"). */
  source: string;
  /** Recursive root containing *.jsonl files. */
  root: string;
  /** Reset offsets to 0 before scanning (forces full re-read). */
  full?: boolean;
  /** Per-line parser; returns a row or null to skip. */
  parseLine: (line: string) => UsageEventRow | null;
}

/** Result of one scan: total new rows + the per-file lines for callers. */
export interface ScanResult {
  inserted: number;
  status: "ok" | "no data";
  files: number;
}

/**
 * Walk `root` recursively for `*.jsonl` files. Missing directory returns [].
 */
export async function collectJsonlFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(p);
      } else if (e.isFile() && p.endsWith(".jsonl")) {
        out.push(p);
      }
    }
  }
  await walk(root);
  return out;
}

/**
 * Read new lines from one JSONL file using the stored sync cursor. Returns
 * the parsed rows and persists the new offset+mtime. The cursor is reset to
 * 0 when the file has shrunk past the stored offset. Empty result when the
 * file is unchanged.
 */
export async function tailFile(
  db: Database,
  source: string,
  path: string,
  parseLine: (line: string) => UsageEventRow | null,
): Promise<{ rows: UsageEventRow[]; changed: boolean; newOffset: number; mtimeMs: number }> {
  let meta;
  try {
    meta = await stat(path);
  } catch {
    return { rows: [], changed: false, newOffset: 0, mtimeMs: 0 };
  }
  const mtimeMs = Math.floor(meta.mtimeMs);
  const size = meta.size;
  const cursor = getSync(db, source, path);
  let offset = cursor?.offset ?? 0;
  if (size < offset) offset = 0;
  if (cursor && cursor.mtime_ms === mtimeMs && size >= offset) {
    return { rows: [], changed: false, newOffset: offset, mtimeMs };
  }
  let buf: Buffer;
  try {
    const fh = await open(path, "r");
    try {
      buf = Buffer.alloc(Math.max(0, size - offset));
      if (buf.length > 0) await fh.read(buf, 0, buf.length, offset);
    } finally {
      await fh.close();
    }
  } catch {
    return { rows: [], changed: false, newOffset: offset, mtimeMs };
  }
  const newOffset = offset + buf.length;
  const rows: UsageEventRow[] = [];
  if (buf.length > 0) {
    const text = buf.toString("utf8");
    for (const raw of text.split("\n")) {
      const line = raw.replace(/\r$/, "");
      if (line.length === 0) continue;
      try {
        const row = parseLine(line);
        if (row) rows.push(row);
      } catch {
        // malformed JSONL line — skip, never fatal
      }
    }
  }
  return { rows, changed: true, newOffset, mtimeMs };
}

/** Drop sync_state rows for the given source so the next tailFile re-reads from 0. */
export function resetCursor(db: Database, source: string, paths?: string[]): void {
  if (paths && paths.length > 0) {
    const stmt = db.query("DELETE FROM sync_state WHERE source = ? AND path = ?");
    for (const p of paths) stmt.run(source, p);
  } else {
    db.query("DELETE FROM sync_state WHERE source = ?").run(source);
  }
}