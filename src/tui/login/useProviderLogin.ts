/**
 * Input + side-effect controller for the provider-login overlay. Owns the modal
 * state (a `useReducer` over `loginModalReducer`) and routes keystrokes while
 * the overlay is open.
 *
 * Side effects:
 * - API-key / admin-key: entered INSIDE the TUI (an `apikey` input view) and
 *   validated + stored asynchronously — the dashboard never drops to the
 *   terminal for text input, so it can't freeze on the readline handoff.
 * - OAuth: runs ENTIRELY inside the TUI. A `LoginUi` adapter surfaces the
 *   authorize URL / user code / paste field / project-id prompt through the
 *   `oauth` modal view; the browser still opens, but the dashboard never
 *   unmounts. A per-run id lets Escape cancel a pending flow without racing a
 *   late-resolving poll against a fresh run.
 * - `d` on an account removes it synchronously and refreshes.
 */
import { useCallback, useReducer, useRef } from "react";
import type { Key } from "ink";
import type { Database } from "bun:sqlite";
import type { Config } from "../../config/types.ts";
import { loginModalReducer, type KeyMethod, type LoginModalState } from "../loginModal.ts";
import type { Action, AccountRow } from "../state.ts";
import { buildDetailRows, buildProviderRows } from "./providerList.ts";
import { removeStoredAccount } from "./perform.ts";
import { oauthLogin, storeAdminKey, storeApiKey, type LoginCtx } from "../../auth/loginFlows.ts";
import type { LoginUi, PasteResult } from "../../auth/oauth/ui.ts";
import { openBrowser } from "../../auth/oauth/callback.ts";
import { parseCallbackInput } from "../../auth/oauth/pkce.ts";

export interface ProviderLogin {
  login: LoginModalState;
  active: boolean;
  open: () => void;
  openDetail: (providerId: string) => void;
  handleInput: (input: string, key: Key) => void;
}

/**
 * The printable text of an input event — a single typed char OR a pasted chunk
 * (Ink delivers a paste as one multi-character `input`). Returns "" for control
 * keys. Bracketed-paste markers and other control bytes are stripped so a pasted
 * API key lands intact instead of being dropped by a length===1 check.
 */
export function printableChunk(input: string, key: Key): string {
  if (
    key.ctrl || key.meta || key.return || key.escape || key.tab ||
    key.backspace || key.delete || key.upArrow || key.downArrow ||
    key.leftArrow || key.rightArrow
  ) return "";
  const cleaned = input.replace(/\u001b\[20[01]~/g, "");
  let out = "";
  for (const ch of cleaned) if (ch >= " " && ch !== "\u007f") out += ch;
  return out;
}

export function useProviderLogin(args: {
  db: Database;
  cfg: Config;
  configFile: string;
  dataDir: string;
  accounts: AccountRow[];
  refresh: () => void;
  dispatch: (a: Action) => void;
}): ProviderLogin {
  const { db, cfg, configFile, dataDir, accounts, refresh, dispatch } = args;
  const [login, modal] = useReducer(loginModalReducer, null);
  // Deferred resolvers for the in-TUI OAuth paste / text inputs, plus a per-run
  // id so Escape (or a newer run) can invalidate a still-pending flow.
  const pasteResolver = useRef<{ resolve: (r: PasteResult) => void; reject: (e: unknown) => void } | null>(null);
  const textResolver = useRef<{ resolve: (s: string) => void } | null>(null);
  const oauthRunId = useRef(0);

  const open = useCallback(() => modal({ t: "open" }), []);
  const openDetail = useCallback((providerId: string) => {
    modal({ t: "open" });
    modal({ t: "toDetail", providerId });
  }, []);

  const submitApiKey = useCallback(
    (providerId: string, method: KeyMethod, key: string, account: string): void => {
      modal({ t: "apikeyBusy", on: true });
      const ctx: LoginCtx = { db, dataDir, cfg, configFile };
      void (async () => {
        try {
          if (method === "adminKey") await storeAdminKey(ctx, providerId, key.trim());
          else await storeApiKey(ctx, providerId, { key: key.trim(), account: account.trim() || undefined });
          modal({ t: "close" });
          dispatch({ t: "setBanner", text: `${providerId}: api key stored (health-check ok)` });
          refresh();
        } catch (e) {
          modal({ t: "apikeyError", message: e instanceof Error ? e.message : String(e) });
        }
      })();
    },
    [db, cfg, configFile, dataDir, dispatch, refresh],
  );

  /** Kick off an OAuth flow entirely inside the TUI via a LoginUi adapter. */
  const runOauth = useCallback(
    (providerId: string): void => {
      const myRun = ++oauthRunId.current;
      modal({ t: "oauthStart", providerId });
      const ui: LoginUi = {
        prompt(info) {
          openBrowser(info.url);
          modal({ t: "oauthPrompt", url: info.url, userCode: info.userCode, needsPaste: info.needsPaste });
        },
        paste() {
          const { promise, resolve, reject } = Promise.withResolvers<PasteResult>();
          pasteResolver.current = { resolve, reject };
          return promise;
        },
        promptText(message: string) {
          const { promise, resolve } = Promise.withResolvers<string>();
          textResolver.current = { resolve };
          modal({ t: "oauthNeedText", message });
          return promise;
        },
      };
      const ctx: LoginCtx = { db, dataDir, cfg, configFile };
      void (async () => {
        try {
          await oauthLogin(ctx, providerId, false, ui);
          if (oauthRunId.current !== myRun) return;
          modal({ t: "close" });
          dispatch({ t: "setBanner", text: `${providerId}: login complete` });
          refresh();
        } catch (e) {
          if (oauthRunId.current !== myRun) return;
          const msg = e instanceof Error ? e.message : String(e);
          modal({ t: "oauthError", message: msg });
        }
      })();
    },
    [db, cfg, configFile, dataDir, dispatch, refresh],
  );

  const handleInput = useCallback(
    (input: string, key: Key): void => {
      if (login === null) return;

      if (login.view === "oauth") {
        if (key.escape) {
          oauthRunId.current++;
          if (pasteResolver.current) {
            pasteResolver.current.reject(new Error("cancelled"));
            pasteResolver.current = null;
          }
          if (textResolver.current) {
            textResolver.current.resolve("");
            textResolver.current = null;
          }
          return modal({ t: "toDetail", providerId: login.providerId });
        }
        if (login.inputMode === "paste") {
          if (key.backspace || key.delete) return modal({ t: "oauthInputBackspace" });
          if (key.return) {
            const parsed = parseCallbackInput(login.input.trim());
            if (!parsed.code) {
              return modal({ t: "oauthError", message: "No authorization code found — paste the code or full redirect URL" });
            }
            const r = pasteResolver.current;
            pasteResolver.current = null;
            modal({ t: "oauthPrompt", url: login.url, userCode: login.userCode });
            r?.resolve({ code: parsed.code, state: parsed.state ?? "" });
            return;
          }
          const chunk = printableChunk(input, key);
          if (chunk) return modal({ t: "oauthInputChar", ch: chunk });
          return;
        }
        if (login.inputMode === "text") {
          if (key.backspace || key.delete) return modal({ t: "oauthInputBackspace" });
          if (key.return) {
            const r = textResolver.current;
            textResolver.current = null;
            modal({ t: "oauthPrompt", url: login.url, userCode: login.userCode });
            r?.resolve(login.input);
            return;
          }
          const chunk = printableChunk(input, key);
          if (chunk) return modal({ t: "oauthInputChar", ch: chunk });
          return;
        }
        // inputMode "none": device flow polling — nothing to type, Esc cancels above.
        return;
      }

      if (login.view === "apikey") {
        if (login.busy) return;
        if (key.escape) return modal({ t: "toDetail", providerId: login.providerId });
        if (key.backspace || key.delete) return modal({ t: "apikeyBackspace" });
        if (key.return) {
          if (login.field === "key") {
            if (login.key.trim().length === 0) return modal({ t: "apikeyError", message: "API key cannot be blank" });
            if (login.method === "apiKey") return modal({ t: "apikeyField", field: "account" });
          }
          return submitApiKey(login.providerId, login.method, login.key, login.account);
        }
        const keyChunk = printableChunk(input, key);
        if (keyChunk) return modal({ t: "apikeyChar", ch: keyChunk });
        return;
      }

      if (login.view === "list") {
        if (key.escape) return modal({ t: "close" });
        if (key.backspace || key.delete) return modal({ t: "filterBackspace" });
        const rows = buildProviderRows(accounts, login.filter);
        if (key.upArrow) return modal({ t: "move", delta: -1, count: rows.length });
        if (key.downArrow) return modal({ t: "move", delta: 1, count: rows.length });
        if (key.return || key.rightArrow) {
          const sel = rows[login.selection];
          if (sel) modal({ t: "toDetail", providerId: sel.id });
          return;
        }
        const filterChunk = printableChunk(input, key);
        if (filterChunk) return modal({ t: "filterChar", ch: filterChunk });
        return;
      }

      // detail view — no filter here, so letter keys are free (d = remove).
      if (key.escape || key.leftArrow) return modal({ t: "toList" });
      const rows = buildDetailRows(login.providerId, accounts);
      if (key.upArrow) return modal({ t: "move", delta: -1, count: rows.length });
      if (key.downArrow) return modal({ t: "move", delta: 1, count: rows.length });
      const row = rows[login.selection];
      if (!row) return;
      if (key.return) {
        if (row.kind === "action") {
          if (row.method === "oauth") runOauth(login.providerId);
          else modal({ t: "startApikey", providerId: login.providerId, method: row.method });
        }
        return;
      }
      if (input === "d" || key.delete) {
        if (row.kind !== "account") return;
        const removed = removeStoredAccount(dataDir, login.providerId, row.account.label);
        dispatch({
          t: "setBanner",
          text: removed
            ? `removed ${login.providerId} · ${row.account.label}`
            : `could not remove ${row.account.label}`,
        });
        if (removed) refresh();
      }
    },
    [login, accounts, dataDir, refresh, dispatch, submitApiKey, runOauth],
  );

  return { login, active: login !== null, open, openDetail, handleInput };
}
