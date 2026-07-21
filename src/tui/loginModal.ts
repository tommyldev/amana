/**
 * State machine for the TUI provider-login overlay. `null` means the overlay is
 * closed. Views: the filterable provider `list`, a per-provider `detail`
 * (accounts + add-actions), and an in-TUI `apikey` input (key/admin-key entry
 * happens inside the dashboard — never by dropping to the terminal). Pure
 * navigation + field editing only; the actual store/validate/refresh side
 * effects live in `useProviderLogin`.
 */
export type KeyMethod = "apiKey" | "adminKey";

export type LoginModalState =
  | { view: "list"; filter: string; selection: number }
  | { view: "detail"; providerId: string; selection: number }
  | {
      view: "apikey";
      providerId: string;
      method: KeyMethod;
      field: "key" | "account";
      key: string;
      account: string;
      busy: boolean;
      error?: string;
    }
  | {
      view: "oauth";
      providerId: string;
      url: string;
      userCode?: string;
      inputMode: "none" | "paste" | "text";
      inputLabel?: string;
      input: string;
      error?: string;
    }
  | null;

export type LoginModalAction =
  | { t: "open" }
  | { t: "close" }
  | { t: "filterChar"; ch: string }
  | { t: "filterBackspace" }
  | { t: "move"; delta: number; count: number }
  | { t: "toDetail"; providerId: string }
  | { t: "toList" }
  | { t: "startApikey"; providerId: string; method: KeyMethod }
  | { t: "apikeyChar"; ch: string }
  | { t: "apikeyBackspace" }
  | { t: "apikeyField"; field: "key" | "account" }
  | { t: "apikeyBusy"; on: boolean }
  | { t: "apikeyError"; message: string }
  | { t: "oauthStart"; providerId: string }
  | { t: "oauthPrompt"; url: string; userCode?: string; needsPaste?: boolean }
  | { t: "oauthNeedText"; message: string }
  | { t: "oauthInputChar"; ch: string }
  | { t: "oauthInputBackspace" }
  | { t: "oauthError"; message: string };

export function loginModalReducer(s: LoginModalState, a: LoginModalAction): LoginModalState {
  switch (a.t) {
    case "open":
      return { view: "list", filter: "", selection: 0 };

    case "close":
      return null;

    case "toDetail":
      return { view: "detail", providerId: a.providerId, selection: 0 };

    case "toList":
      return { view: "list", filter: "", selection: 0 };

    case "startApikey":
      return {
        view: "apikey",
        providerId: a.providerId,
        method: a.method,
        field: "key",
        key: "",
        account: "",
        busy: false,
      };

    case "filterChar":
      if (s?.view !== "list") return s;
      return { ...s, filter: s.filter + a.ch, selection: 0 };

    case "filterBackspace":
      if (s?.view !== "list") return s;
      return { ...s, filter: s.filter.slice(0, -1), selection: 0 };

    case "move": {
      if (s === null || (s.view !== "list" && s.view !== "detail")) return s;
      if (a.count <= 0) return { ...s, selection: 0 };
      const raw = s.selection + a.delta;
      return { ...s, selection: ((raw % a.count) + a.count) % a.count };
    }

    case "apikeyChar":
      if (s?.view !== "apikey" || s.busy) return s;
      return s.field === "key" ? { ...s, key: s.key + a.ch, error: undefined } : { ...s, account: s.account + a.ch };

    case "apikeyBackspace":
      if (s?.view !== "apikey" || s.busy) return s;
      return s.field === "key" ? { ...s, key: s.key.slice(0, -1) } : { ...s, account: s.account.slice(0, -1) };

    case "apikeyField":
      if (s?.view !== "apikey") return s;
      return { ...s, field: a.field, error: undefined };

    case "apikeyBusy":
      if (s?.view !== "apikey") return s;
      return { ...s, busy: a.on, error: undefined };

    case "apikeyError":
      if (s?.view !== "apikey") return s;
      return { ...s, busy: false, error: a.message };

    case "oauthStart":
      return { view: "oauth", providerId: a.providerId, url: "", inputMode: "none", input: "" };

    case "oauthPrompt":
      if (s?.view !== "oauth") return s;
      return {
        ...s,
        url: a.url,
        userCode: a.userCode,
        inputMode: a.needsPaste ? "paste" : "none",
        input: "",
        error: undefined,
      };

    case "oauthNeedText":
      if (s?.view !== "oauth") return s;
      return { ...s, inputMode: "text", inputLabel: a.message, input: "", error: undefined };

    case "oauthInputChar":
      if (s?.view !== "oauth" || (s.inputMode !== "paste" && s.inputMode !== "text")) return s;
      return { ...s, input: s.input + a.ch };

    case "oauthInputBackspace":
      if (s?.view !== "oauth" || (s.inputMode !== "paste" && s.inputMode !== "text")) return s;
      return { ...s, input: s.input.slice(0, -1) };

    case "oauthError":
      if (s?.view !== "oauth") return s;
      return { ...s, inputMode: "none", error: a.message };
  }
}
