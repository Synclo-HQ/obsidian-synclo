import { SyncloError, MESSAGES } from "../api/errors";
import { NetworkError, type Http } from "../api/http";
import { OAuthError, authorizeUrl, exchangeCode, refreshTokens, revokeToken, type TokenSet } from "./oauth";
import { challengeFor, makeState, randomToken, vaultOfState } from "./pkce";

/**
 * The sign-in on this device. Tokens live only in Obsidian's secret
 * storage (this device, this vault), never in the vault or data.json, and
 * are never logged. The access token lasts an hour; the refresh token
 * changes on every use, so a refresh is single-flight and its new refresh
 * token is saved before anything else happens.
 */

export interface SecretStore {
  get(id: string): string | null;
  /** An empty value clears the secret. */
  set(id: string, value: string): void;
}

export interface SessionDeps {
  http: Http;
  secrets: SecretStore;
  crypto: Crypto;
  now: () => number;
  /** The server address in use (normalized). */
  base: () => string;
}

interface Stored extends TokenSet {
  v: 1;
  /** The server the tokens belong to; they are never sent anywhere else. */
  base: string;
}

interface Pending {
  v: 1;
  state: string;
  verifier: string;
  base: string;
  createdAt: number;
}

export const SECRET_TOKENS = "synclo-sign-in";
export const SECRET_PENDING = "synclo-sign-in-pending";
/** A sign-in started longer ago than this is not finished (Synclo's code
 *  lasts 10 minutes). */
const PENDING_LIFE_MS = 15 * 60 * 1000;
/** Refresh a little before the hour is up. */
const EARLY_MS = 60 * 1000;

export type SignInResult =
  | { kind: "connected" }
  | { kind: "declined" }
  | { kind: "failed"; message: string }
  /** The sign-in was started in another vault: hand it over. */
  | { kind: "elsewhere"; vault: string }
  /** No sign-in was waiting for this answer (used, expired, or not ours). */
  | { kind: "stale" };

export type SignedOutReason = "disconnected" | "expired";

export class Session {
  private refreshing: Promise<Stored> | null = null;
  private listeners = new Set<(signedIn: boolean, reason?: SignedOutReason) => void>();

  constructor(private readonly deps: SessionDeps) {}

  /** Signed in to the server in use. */
  isSignedIn(): boolean {
    return this.load() !== null;
  }

  onChange(listener: (signedIn: boolean, reason?: SignedOutReason) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A working access token, refreshed when it is about to expire. */
  async accessToken(): Promise<string> {
    const tokens = this.load();
    if (!tokens) throw new SyncloError("signed-out", MESSAGES.signedOut);
    if (tokens.expiresAt - EARLY_MS > this.deps.now()) return tokens.access;
    return (await this.refresh()).access;
  }

  /** A new access token after Synclo refused `rejected` (a 401). If another
   *  request already refreshed, its token is used; refreshes never overlap. */
  async tokenAfterRejection(rejected: string): Promise<string> {
    if (this.refreshing) return (await this.refreshing).access;
    const tokens = this.load();
    if (!tokens) throw new SyncloError("signed-out", MESSAGES.signedOut);
    if (tokens.access !== rejected) return tokens.access;
    return (await this.refresh()).access;
  }

  /** The address to open in the browser to sign in. */
  async startSignIn(vaultName: string): Promise<string> {
    const base = this.deps.base();
    const verifier = randomToken(this.deps.crypto, 32);
    const state = makeState(this.deps.crypto, vaultName);
    const pending: Pending = { v: 1, state, verifier, base, createdAt: this.deps.now() };
    // Kept in secret storage, so a phone that closes Obsidian while the
    // browser is open can still finish the sign-in.
    this.deps.secrets.set(SECRET_PENDING, JSON.stringify(pending));
    return authorizeUrl(base, await challengeFor(this.deps.crypto, verifier), state);
  }

  /** Finishes a sign-in from the obsidian://synclo-auth answer. */
  async finishSignIn(params: Record<string, string>, vaultName: string): Promise<SignInResult> {
    const state = params.state ?? "";
    const pending = this.loadPending();
    if (!pending || !state || pending.state !== state) {
      const from = state ? vaultOfState(state) : null;
      // Handed over once only: an answer that already names a vault is not
      // passed on again.
      if (from !== null && from !== vaultName && !params.vault) return { kind: "elsewhere", vault: from };
      return { kind: "stale" };
    }
    // One answer per sign-in.
    this.deps.secrets.set(SECRET_PENDING, "");
    if (this.deps.now() - pending.createdAt > PENDING_LIFE_MS) return { kind: "stale" };
    if (params.error) {
      if (params.error === "access_denied") return { kind: "declined" };
      return { kind: "failed", message: params.error_description || "Synclo couldn't connect. Try again." };
    }
    if (pending.base !== this.deps.base()) return { kind: "failed", message: "The server address changed while you were signing in. Connect again." };
    // RFC 9207: the answer must come from the server the sign-in went to.
    if ((params.iss ?? "").replace(/\/+$/, "") !== pending.base) return { kind: "failed", message: "The sign-in came back from a different server than it went to, so it wasn't used. Connect again." };
    if (!params.code) return { kind: "failed", message: "Synclo didn't send a sign-in code. Connect again." };
    try {
      const tokens = await exchangeCode(this.deps.http, pending.base, params.code, pending.verifier, this.deps.now);
      this.save({ ...tokens, v: 1, base: pending.base });
    } catch (err) {
      if (err instanceof NetworkError) return { kind: "failed", message: MESSAGES.network };
      if (err instanceof OAuthError && err.status >= 500) return { kind: "failed", message: MESSAGES.unavailable };
      return { kind: "failed", message: "Synclo couldn't finish connecting. Connect again." };
    }
    this.emit(true);
    return { kind: "connected" };
  }

  /** Disconnects: ends this device's sign-in on Synclo, then forgets it. */
  async signOut(): Promise<void> {
    const tokens = this.load();
    this.forget("disconnected");
    if (tokens) await revokeToken(this.deps.http, tokens.base, tokens.refresh).catch(() => undefined);
  }

  /** Forgets the sign-in on this device without asking Synclo. */
  forget(reason: SignedOutReason): void {
    const had = this.load() !== null;
    this.deps.secrets.set(SECRET_TOKENS, "");
    if (had) this.emit(false, reason);
  }

  private async refresh(): Promise<Stored> {
    if (this.refreshing) return this.refreshing;
    const current = this.load();
    if (!current) throw new SyncloError("signed-out", MESSAGES.signedOut);
    this.refreshing = (async () => {
      try {
        const next = await refreshTokens(this.deps.http, current.base, current.refresh, this.deps.now);
        const stored: Stored = { ...next, v: 1, base: current.base };
        // The old refresh token no longer works: keep the new one first.
        this.save(stored);
        return stored;
      } catch (err) {
        if (err instanceof OAuthError) {
          if (err.status >= 500 || err.status === 429) throw new SyncloError(err.status === 429 ? "rate-limited" : "unavailable", MESSAGES.unavailable);
          // invalid_grant and kin: the sign-in is over on Synclo's side.
          this.forget("expired");
          throw new SyncloError("signed-out", MESSAGES.signInEnded);
        }
        if (err instanceof NetworkError) throw new SyncloError("network", MESSAGES.network);
        throw err;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  private load(): Stored | null {
    const raw = this.deps.secrets.get(SECRET_TOKENS);
    if (!raw) return null;
    try {
      const t = JSON.parse(raw) as Partial<Stored>;
      if (t.v !== 1 || typeof t.access !== "string" || typeof t.refresh !== "string" || typeof t.expiresAt !== "number" || typeof t.base !== "string") return null;
      // Tokens for another server stay unused (and are never sent there).
      if (t.base !== this.deps.base()) return null;
      return t as Stored;
    } catch {
      return null;
    }
  }

  private save(tokens: Stored): void {
    this.deps.secrets.set(SECRET_TOKENS, JSON.stringify(tokens));
  }

  private loadPending(): Pending | null {
    const raw = this.deps.secrets.get(SECRET_PENDING);
    if (!raw) return null;
    try {
      const p = JSON.parse(raw) as Partial<Pending>;
      if (p.v !== 1 || typeof p.state !== "string" || typeof p.verifier !== "string" || typeof p.base !== "string" || typeof p.createdAt !== "number") return null;
      return p as Pending;
    } catch {
      return null;
    }
  }

  private emit(signedIn: boolean, reason?: SignedOutReason): void {
    for (const l of this.listeners) l(signedIn, reason);
  }
}
