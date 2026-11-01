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

/** Obsidian's local storage for this vault on this device. */
export interface LocalStore {
  load(key: string): unknown;
  /** null removes the value. */
  save(key: string, value: unknown): void;
}

export interface SessionDeps {
  http: Http;
  secrets: SecretStore;
  /** Where a sign-in waiting for its answer is kept. */
  local: LocalStore;
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
/** Where a waiting sign-in was kept before it moved to local storage
 *  (read once, then cleared). */
export const SECRET_PENDING = "synclo-sign-in-pending";
export const LOCAL_PENDING = "synclo-sign-in-pending";
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
  private endedListeners = new Set<() => void>();

  constructor(private readonly deps: SessionDeps) {}

  /** Signed in to the server in use. */
  isSignedIn(): boolean {
    return this.load() !== null;
  }

  onChange(listener: (signedIn: boolean, reason?: SignedOutReason) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A sign-in came back without connecting (declined, failed, or an
   *  answer no sign-in was waiting for): whatever waits on it shows
   *  Connect again. */
  onSignInEnded(listener: () => void): () => void {
    this.endedListeners.add(listener);
    return () => this.endedListeners.delete(listener);
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
    const prepared = await this.prepare(vaultName);
    this.keep(prepared.pending);
    return prepared.url;
  }

  /**
   * Gets a sign-in ready before the person clicks Connect, so the click can
   * open the browser at once (a browser may refuse to open a page after
   * the click has waited on anything).
   */
  async prepareSignIn(vaultName: string): Promise<void> {
    this.prepared = await this.prepare(vaultName);
  }

  /** The prepared sign-in's address, now started; null when none is ready. */
  takePreparedSignIn(): string | null {
    const p = this.prepared;
    this.prepared = null;
    if (!p || p.pending.base !== this.deps.base() || this.deps.now() - p.pending.createdAt > PENDING_LIFE_MS / 2) return null;
    this.keep({ ...p.pending, createdAt: this.deps.now() });
    return p.url;
  }

  private prepared: { url: string; pending: Pending } | null = null;

  private async prepare(vaultName: string): Promise<{ url: string; pending: Pending }> {
    const base = this.deps.base();
    const verifier = randomToken(this.deps.crypto, 32);
    const state = makeState(this.deps.crypto, vaultName);
    const pending: Pending = { v: 1, state, verifier, base, createdAt: this.deps.now() };
    return { url: authorizeUrl(base, await challengeFor(this.deps.crypto, verifier), state), pending };
  }

  /** Kept in this vault's local storage on this device, so a phone that
   *  closes Obsidian while the browser is open can still finish the
   *  sign-in. */
  private keep(pending: Pending): void {
    this.deps.local.save(LOCAL_PENDING, pending);
  }

  private clearPending(): void {
    this.deps.local.save(LOCAL_PENDING, null);
  }

  /** Finishes a sign-in from the obsidian://synclo-auth answer. */
  async finishSignIn(params: Record<string, string>, vaultName: string): Promise<SignInResult> {
    const result = await this.finish(params, vaultName);
    if (result.kind === "declined" || result.kind === "failed" || result.kind === "stale") for (const l of this.endedListeners) l();
    return result;
  }

  private async finish(params: Record<string, string>, vaultName: string): Promise<SignInResult> {
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
    this.clearPending();
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
        const next = await refreshTokens(this.deps.http, current.base, current.refresh, this.deps.now, (late) => {
          // The answer came after the wait was given up. Its refresh token
          // is the one that works now, unless a later refresh already
          // replaced the one sent (or the person disconnected).
          if (this.load()?.refresh === current.refresh) this.save({ ...late, v: 1, base: current.base });
        });
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
    let value: unknown = this.deps.local.load(LOCAL_PENDING);
    // A sign-in started before it moved here: read once, then moved.
    const old = this.deps.secrets.get(SECRET_PENDING);
    if (old) {
      this.deps.secrets.set(SECRET_PENDING, "");
      if (value === null || value === undefined) {
        try {
          value = JSON.parse(old) as unknown;
          this.deps.local.save(LOCAL_PENDING, value);
        } catch {
          value = null;
        }
      }
    }
    if (typeof value !== "object" || value === null) return null;
    const p = value as Partial<Pending>;
    if (p.v !== 1 || typeof p.state !== "string" || typeof p.verifier !== "string" || typeof p.base !== "string" || typeof p.createdAt !== "number") return null;
    return p as Pending;
  }

  private emit(signedIn: boolean, reason?: SignedOutReason): void {
    for (const l of this.listeners) l(signedIn, reason);
  }
}
