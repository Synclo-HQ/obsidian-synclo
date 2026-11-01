import { NetworkError, isRecord, jsonOf, type Http, type HttpResponse } from "../api/http";

/**
 * Synclo's OAuth 2.1 endpoints for this plugin, a public client (no
 * secret; PKCE S256 proves the sign-in). The browser shows Synclo's Allow
 * page; Synclo's page at /connect/obsidian hands the answer back to
 * Obsidian as obsidian://synclo-auth.
 */

export const CLIENT_ID = "synclo-obsidian";
export const SCOPE = "presentations:read presentations:write";
export const DEFAULT_BASE = "https://synclo.app";

export interface Endpoints {
  authorize: string;
  token: string;
  revoke: string;
  redirect: string;
  resource: string;
  mcp: string;
  images: string;
}

/** A server address as the plugin stores it: no trailing slash; https, or
 *  http only for this computer (development). Null when it isn't one. */
export function normalizeBase(input: string): string | null {
  const raw = input.trim().replace(/\/+$/, "");
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

export function endpoints(base: string): Endpoints {
  return {
    authorize: `${base}/oauth/authorize`,
    token: `${base}/oauth/token`,
    revoke: `${base}/oauth/revoke`,
    redirect: `${base}/connect/obsidian`,
    resource: `${base}/mcp`,
    mcp: `${base}/mcp`,
    images: `${base}/mcp/images`,
  };
}

export function authorizeUrl(base: string, challenge: string, state: string): string {
  const e = endpoints(base);
  const q = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: e.redirect,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: SCOPE,
    state,
    resource: e.resource,
  });
  return `${e.authorize}?${q.toString()}`;
}

export interface TokenSet {
  access: string;
  refresh: string;
  /** When the access token stops working (ms since epoch). */
  expiresAt: number;
  scope: string;
}

/** An error the token endpoint answered (RFC 6749 §5.2). */
export class OAuthError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    description: string,
  ) {
    super(description || code);
    this.name = "OAuthError";
  }
}

const TOKEN_TIMEOUT_MS = 30_000;

async function postForm(http: Http, url: string, form: Record<string, string>, late?: (response: HttpResponse) => void): Promise<unknown> {
  const res = await http({
    url,
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    headers: { Accept: "application/json" },
    body: new URLSearchParams(form).toString(),
    timeoutMs: TOKEN_TIMEOUT_MS,
    ...(late ? { late } : {}),
  });
  const body = jsonOf(res);
  if (res.status >= 200 && res.status < 300) return body;
  const err = isRecord(body) ? body : {};
  const code = typeof err.error === "string" ? err.error : res.status >= 500 ? "server_error" : "invalid_request";
  throw new OAuthError(code, res.status, typeof err.error_description === "string" ? err.error_description : "");
}

function tokenSet(body: unknown, now: number, previousRefresh?: string): TokenSet {
  if (!isRecord(body) || typeof body.access_token !== "string" || !body.access_token) throw new OAuthError("invalid_response", 200, "Synclo's sign-in answered without a token.");
  const refresh = typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : previousRefresh;
  if (!refresh) throw new OAuthError("invalid_response", 200, "Synclo's sign-in answered without a refresh token.");
  const expiresIn = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
  return { access: body.access_token, refresh, expiresAt: now + expiresIn * 1000, scope: typeof body.scope === "string" ? body.scope : SCOPE };
}

export async function exchangeCode(http: Http, base: string, code: string, verifier: string, now: () => number): Promise<TokenSet> {
  const e = endpoints(base);
  const body = await postForm(http, e.token, { grant_type: "authorization_code", code, redirect_uri: e.redirect, code_verifier: verifier, client_id: CLIENT_ID, resource: e.resource });
  return tokenSet(body, now());
}

/** Exchanges the refresh token for new tokens. Synclo rotates the refresh
 *  token on every use, so an answer that arrives after the wait was given
 *  up still carries the only refresh token that works: it is handed to
 *  `onLate`. */
export async function refreshTokens(http: Http, base: string, refresh: string, now: () => number, onLate?: (tokens: TokenSet) => void): Promise<TokenSet> {
  const e = endpoints(base);
  const late = onLate
    ? (res: HttpResponse) => {
        if (res.status < 200 || res.status >= 300) return;
        try {
          onLate(tokenSet(jsonOf(res), now(), refresh));
        } catch {
          // An answer without tokens: nothing to keep.
        }
      }
    : undefined;
  const body = await postForm(http, e.token, { grant_type: "refresh_token", refresh_token: refresh, client_id: CLIENT_ID, resource: e.resource }, late);
  return tokenSet(body, now(), refresh);
}

/** Ends this device's sign-in on Synclo. Best effort: a failure here never
 *  keeps the person signed in locally. */
export async function revokeToken(http: Http, base: string, token: string): Promise<void> {
  try {
    await http({
      url: endpoints(base).revoke,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body: new URLSearchParams({ token, client_id: CLIENT_ID }).toString(),
      timeoutMs: 15_000,
    });
  } catch (err) {
    if (!(err instanceof NetworkError)) throw err;
  }
}
