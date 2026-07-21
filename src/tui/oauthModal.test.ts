import { describe, expect, test } from "bun:test";

import { loginModalReducer } from "./loginModal.ts";

const open = loginModalReducer(null, { t: "open" });

describe("oauth modal reducer", () => {
  test("oauthStart opens the oauth view, waiting for the prompt", () => {
    const s = loginModalReducer(open, { t: "oauthStart", providerId: "xai-oauth" });
    expect(s?.view).toBe("oauth");
    if (s?.view !== "oauth") throw new Error("expected oauth view");
    expect(s.providerId).toBe("xai-oauth");
    expect(s.url).toBe("");
    expect(s.inputMode).toBe("none");
    expect(s.input).toBe("");
  });

  test("oauthPrompt with needsPaste reveals the paste field", () => {
    const s0 = loginModalReducer(open, { t: "oauthStart", providerId: "anthropic" });
    const s = loginModalReducer(s0, { t: "oauthPrompt", url: "https://claude.ai/x", needsPaste: true });
    if (s?.view !== "oauth") throw new Error("expected oauth view");
    expect(s.url).toBe("https://claude.ai/x");
    expect(s.inputMode).toBe("paste");
    expect(s.error).toBeUndefined();
  });

  test("oauthPrompt for a device flow (userCode) stays input-free", () => {
    const s0 = loginModalReducer(open, { t: "oauthStart", providerId: "xai-oauth" });
    const s = loginModalReducer(s0, { t: "oauthPrompt", url: "https://x.ai/y", userCode: "ABCD" });
    if (s?.view !== "oauth") throw new Error("expected oauth view");
    expect(s.userCode).toBe("ABCD");
    expect(s.inputMode).toBe("none");
  });

  test("oauthInputChar only appends while a paste/text field is active", () => {
    const s0 = loginModalReducer(open, { t: "oauthStart", providerId: "anthropic" });
    const ignored = loginModalReducer(s0, { t: "oauthInputChar", ch: "x" });
    if (ignored?.view !== "oauth") throw new Error("expected oauth view");
    expect(ignored.input).toBe("");

    const paste = loginModalReducer(s0, { t: "oauthPrompt", url: "u", needsPaste: true });
    const typed = loginModalReducer(paste, { t: "oauthInputChar", ch: "Z" });
    if (typed?.view !== "oauth") throw new Error("expected oauth view");
    expect(typed.input).toBe("Z");
  });

  test("oauthInputBackspace trims the field", () => {
    let s = loginModalReducer(open, { t: "oauthStart", providerId: "anthropic" });
    s = loginModalReducer(s, { t: "oauthPrompt", url: "u", needsPaste: true });
    s = loginModalReducer(s, { t: "oauthInputChar", ch: "a" });
    s = loginModalReducer(s, { t: "oauthInputChar", ch: "b" });
    s = loginModalReducer(s, { t: "oauthInputBackspace" });
    if (s?.view !== "oauth") throw new Error("expected oauth view");
    expect(s.input).toBe("a");
  });

  test("oauthNeedText switches to the text input", () => {
    const s0 = loginModalReducer(open, { t: "oauthStart", providerId: "google-gemini-cli" });
    const s = loginModalReducer(s0, { t: "oauthNeedText", message: "Project id:" });
    if (s?.view !== "oauth") throw new Error("expected oauth view");
    expect(s.inputMode).toBe("text");
    expect(s.inputLabel).toBe("Project id:");
  });

  test("oauthError clears the input mode and records the message", () => {
    const s0 = loginModalReducer(open, { t: "oauthStart", providerId: "xai-oauth" });
    const s = loginModalReducer(s0, { t: "oauthError", message: "boom" });
    if (s?.view !== "oauth") throw new Error("expected oauth view");
    expect(s.error).toBe("boom");
    expect(s.inputMode).toBe("none");
  });

  test("close returns null from the oauth view", () => {
    const s0 = loginModalReducer(open, { t: "oauthStart", providerId: "xai-oauth" });
    expect(loginModalReducer(s0, { t: "close" })).toBe(null);
  });
});
