/**
 * Credential persistence: `credentials.json` in `dataDir` (mode 0600).
 * One `Credential[]` array per provider id.
 *
 * Port of `auth/store.rs`. Merge dedup semantics are EXACTLY the Rust
 * `merge()`: a credential with an identity replaces any existing one with the
 * same identity; a credential without an identity replaces the lone
 * identity-less credential; distinct identities accumulate (multi-account).
 */
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { credentialsFile } from "../config/paths.ts";
import type { Credential } from "./types.ts";
import { identity } from "./types.ts";
import { SUPPORTED_PROVIDERS } from "../usage/types.ts";

export function load(dataDir: string, provider: string): Credential[] {
  const file = credentialsFile(dataDir);
  if (!existsSync(file)) return [];
  const all = readAll(file);
  if (!all) return [];
  warnIfInsecurePermissions(file);
  const entry = all[provider];
  return entry ? entry.slice() : [];
}

export function save(dataDir: string, provider: string, creds: Credential[]): void {
  const file = credentialsFile(dataDir);
  const all = existsSync(file) ? readAll(file) ?? {} : {};
  if (creds.length === 0) {
    delete all[provider];
  } else {
    all[provider] = creds;
  }
  writeAtomic(file, all);
  chmodSync(file, 0o600);
}

export function upsert(dataDir: string, provider: string, cred: Credential): void {
  const creds = load(dataDir, provider);
  merge(creds, cred);
  save(dataDir, provider, creds);
}

export function removeAccount(dataDir: string, provider: string, accountIdentity: string): boolean {
  const creds = load(dataDir, provider);
  const idx = creds.findIndex((c) => identity(c) === accountIdentity);
  if (idx < 0) return false;
  creds.splice(idx, 1);
  save(dataDir, provider, creds);
  return true;
}

export function allProviders(dataDir: string): string[] {
  const file = credentialsFile(dataDir);
  if (!existsSync(file)) return [];
  const all = readAll(file);
  if (!all) return [];
  const supported = new Set(SUPPORTED_PROVIDERS);
  return Object.keys(all).filter((k) => supported.has(k) && Array.isArray(all[k]) && all[k].length > 0);
}

/**
 * Pure dedup (exported for tests). Mutates `creds` in place.
 * Mirrors Rust `merge()`: same identity replaces; identity-less replaces the
 * lone identity-less credential; distinct identities accumulate.
 */
export function merge(creds: Credential[], cred: Credential): void {
  const id = identity(cred);
  if (id != null) {
    for (let i = 0; i < creds.length; i++) {
      if (identity(creds[i]) === id) {
        creds[i] = cred;
        return;
      }
    }
    creds.push(cred);
    return;
  }
  for (let i = 0; i < creds.length; i++) {
    if (identity(creds[i]) == null) {
      creds[i] = cred;
      return;
    }
  }
  creds.push(cred);
}

function readAll(file: string): Record<string, Credential[]> | null {
  try {
    const txt = readFileSync(file, "utf8");
    if (!txt.trim()) return {};
    const parsed = JSON.parse(txt);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, Credential[]>;
  } catch {
    return null;
  }
}

function writeAtomic(file: string, all: Record<string, Credential[]>): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(all, null, 2));
}

function warnIfInsecurePermissions(file: string): void {
  try {
    const mode = statSync(file).mode & 0o777;
    if (mode & 0o077) {
      process.stderr.write(
        `warning: ${file} is group/world readable (mode 0o${mode.toString(8)}); chmod 600 recommended\n`,
      );
    }
  } catch {
    // ignore
  }
}