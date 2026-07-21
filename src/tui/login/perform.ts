/**
 * Login side effects driven by the TUI provider manager. `performLogin` runs an
 * interactive flow (browser/prompt) and MUST be called with the terminal in its
 * normal screen — `run.ts` suspends the alternate screen around it.
 * `removeStoredAccount` is synchronous store I/O, safe to call from the TUI.
 */
import {
  adminKeyLogin,
  apiKeyLogin,
  isMixed,
  oauthLogin,
  type LoginCtx,
} from "../../auth/loginFlows.ts";
import * as credStore from "../../auth/store.ts";
import { accountLabel, identity } from "../../auth/types.ts";
import type { LoginMethod } from "./providerList.ts";

export interface LoginRequest {
  providerId: string;
  method: LoginMethod;
}

/** Run the login flow for one request; never throws (result carries the error). */
export async function performLogin(ctx: LoginCtx, req: LoginRequest): Promise<{ ok: boolean; message: string }> {
  const { providerId: id, method } = req;
  try {
    if (method === "oauth") await oauthLogin(ctx, id, false);
    else if (method === "adminKey") await adminKeyLogin(ctx, id);
    else if (isMixed(id)) await oauthLogin(ctx, id, true);
    else await apiKeyLogin(ctx, id);
    return { ok: true, message: `${id}: login complete` };
  } catch (e) {
    return { ok: false, message: `${id}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Drop a stored credential by its account label or identity. Returns true when
 *  a matching credential was found and removed. */
export function removeStoredAccount(dataDir: string, providerId: string, label: string): boolean {
  const creds = credStore.load(dataDir, providerId);
  const idx = creds.findIndex((c) => accountLabel(c) === label || identity(c) === label);
  if (idx < 0) return false;
  creds.splice(idx, 1);
  credStore.save(dataDir, providerId, creds);
  return true;
}
