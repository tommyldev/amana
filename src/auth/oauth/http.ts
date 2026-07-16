/**
 * Tiny OAuth HTTP helpers. Non-2xx responses throw with status + body text so
 * callers can surface the provider's actual error message.
 */
export async function postForm(url: string, params: Record<string, string>): Promise<unknown> {
  const body = new URLSearchParams(params).toString();
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  const text = await resp.text();
  if (!resp.ok) throw new OAuthHttpError(resp.status, url, text);
  return text === "" ? null : JSON.parse(text);
}

export async function postJson(url: string, body: unknown): Promise<unknown> {
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) throw new OAuthHttpError(resp.status, url, text);
  return text === "" ? null : JSON.parse(text);
}

export async function postJsonRaw(url: string, body: unknown): Promise<string> {
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) throw new OAuthHttpError(resp.status, url, text);
  return text;
}

export class OAuthHttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly bodyText: string;
  constructor(status: number, url: string, bodyText: string) {
    super(`HTTP ${status} from ${url}: ${bodyText}`);
    this.name = "OAuthHttpError";
    this.status = status;
    this.url = url;
    this.bodyText = bodyText;
  }
}