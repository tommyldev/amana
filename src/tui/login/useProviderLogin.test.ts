/**
 * printableChunk decides what an input event contributes to a text field. It
 * must accept a PASTE (Ink delivers it as one multi-character `input`), not just
 * single typed chars — otherwise a pasted API key is dropped and the field
 * looks empty.
 */
import { describe, expect, test } from "bun:test";
import type { Key } from "ink";
import { printableChunk } from "./useProviderLogin.ts";

function key(over: Partial<Key> = {}): Key {
  // printableChunk reads only these Key flags; the full Ink Key has many more
  // fields, so cast this partial (test seam) rather than restate every flag.
  return {
    ctrl: false, meta: false, return: false, escape: false, tab: false,
    backspace: false, delete: false, upArrow: false, downArrow: false,
    leftArrow: false, rightArrow: false,
    ...over,
  } as unknown as Key;
}

describe("printableChunk", () => {
  test("passes a single typed character", () => {
    expect(printableChunk("a", key())).toBe("a");
  });

  test("passes a pasted multi-character key intact", () => {
    expect(printableChunk("sk-ant-api03-AbC123", key())).toBe("sk-ant-api03-AbC123");
  });

  test("strips bracketed-paste markers around a paste", () => {
    expect(printableChunk("\u001b[200~sk-xyz-9\u001b[201~", key())).toBe("sk-xyz-9");
  });

  test("drops control keys (return/escape/arrows/ctrl)", () => {
    expect(printableChunk("", key({ return: true }))).toBe("");
    expect(printableChunk("", key({ escape: true }))).toBe("");
    expect(printableChunk("", key({ upArrow: true }))).toBe("");
    expect(printableChunk("c", key({ ctrl: true }))).toBe("");
  });

  test("filters stray control bytes but keeps the printable key", () => {
    expect(printableChunk("sk\u0007-abc", key())).toBe("sk-abc");
  });
});
