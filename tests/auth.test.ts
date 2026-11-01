import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SyncloError } from "../src/api/errors";
import { authorizeUrl, normalizeBase } from "../src/auth/oauth";
import { base64url, challengeFor, fromBase64url, makeState, vaultOfState } from "../src/auth/pkce";
import { SECRET_PENDING, SECRET_TOKENS, Session } from "../src/auth/session";
import { fakeHttp, form, memorySecrets } from "./fake-http";

const crypto = webcrypto as unknown as Crypto;
const BASE = "https://synclo.app";

function session(handler: Parameters<typeof fakeHttp>[0], now = () => 1_000_000) {
  const { http, requests } = fakeHttp(handler);
  const secrets = memorySecrets();
  const s = new Session({ http, secrets, crypto, now, base: () => BASE });
  return { s, secrets, requests };
}

function signedIn(secrets: ReturnType<typeof memorySecrets>, expiresAt: number, refresh = "syr_1", access = "syo_1") {
  secrets.set(SECRET_TOKENS, JSON.stringify({ v: 1, base: BASE, access, refresh, expiresAt, scope: "presentations:read presentations:write" }));
}

describe("PKCE", () => {
  it("matches RFC 7636's example", async () => {
    expect(await challengeFor(crypto, "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("round-trips base64url", () => {
    for (const len of [0, 1, 2, 3, 4, 31, 32]) {
      const bytes = new Uint8Array(len).map((_v, i) => (i * 37 + 11) % 256);
      expect(Array.from(fromBase64url(base64url(bytes)) ?? [])).toEqual(Array.from(bytes));
    }
  });

  it("carries the vault's name in the state", () => {
    const state = makeState(crypto, "Work notes · 2026");
    expect(state).toMatch(/^[A-Za-z0-9_-]{32}\.[A-Za-z0-9_-]+$/);
    expect(vaultOfState(state)).toBe("Work notes · 2026");
    expect(vaultOfState("no-dot")).toBeNull();
  });
});

describe("the server address", () => {
  it("takes https anywhere and http only on this computer", () => {
    expect(normalizeBase("https://synclo.app/")).toBe("https://synclo.app");
    expect(normalizeBase("http://localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeBase("http://synclo.app")).toBeNull();
    expect(normalizeBase("https://synclo.app/?x=1")).toBeNull();
    expect(normalizeBase("not a url")).toBeNull();
  });

  it("builds the authorize address the contract names", () => {
    const u = new URL(authorizeUrl(BASE, "chal", "st.ate"));
    expect(u.origin + u.pathname).toBe("https://synclo.app/oauth/authorize");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      response_type: "code",
      client_id: "synclo-obsidian",
      redirect_uri: "https://synclo.app/connect/obsidian",
      code_challenge: "chal",
      code_challenge_method: "S256",
      scope: "presentations:read presentations:write",
      state: "st.ate",
      resource: "https://synclo.app/mcp",
    });
  });
});

describe("signing in", () => {
  it("exchanges the code with the verifier and keeps the tokens in secret storage", async () => {
    const { s, secrets, requests } = session(() => ({ status: 200, body: { access_token: "syo_a", refresh_token: "syr_a", expires_in: 3600, token_type: "Bearer", scope: "presentations:read presentations:write" } }));
    const url = new URL(await s.startSignIn("Vault"));
    const state = url.searchParams.get("state") ?? "";
    const pending = JSON.parse(secrets.get(SECRET_PENDING) ?? "{}");
    const result = await s.finishSignIn({ action: "synclo-auth", code: "c0de", state, iss: BASE }, "Vault");
    expect(result).toEqual({ kind: "connected" });
    expect(form(requests[0]!)).toEqual({
      grant_type: "authorization_code",
      code: "c0de",
      redirect_uri: "https://synclo.app/connect/obsidian",
      code_verifier: pending.verifier,
      client_id: "synclo-obsidian",
      resource: "https://synclo.app/mcp",
    });
    expect(await challengeFor(crypto, pending.verifier)).toBe(url.searchParams.get("code_challenge"));
    expect(secrets.get(SECRET_PENDING)).toBeNull();
    expect(JSON.parse(secrets.get(SECRET_TOKENS) ?? "{}")).toMatchObject({ access: "syo_a", refresh: "syr_a", base: BASE });
    expect(s.isSignedIn()).toBe(true);
  });

  it("refuses an answer from another server", async () => {
    const { s } = session(() => ({ status: 200, body: {} }));
    const state = new URL(await s.startSignIn("Vault")).searchParams.get("state") ?? "";
    const r = await s.finishSignIn({ code: "c", state, iss: "https://evil.example" }, "Vault");
    expect(r.kind).toBe("failed");
    expect(s.isSignedIn()).toBe(false);
  });

  it("refuses a state it didn't make, and uses each answer once", async () => {
    const { s } = session(() => ({ status: 200, body: { access_token: "a", refresh_token: "r", expires_in: 3600 } }));
    const state = new URL(await s.startSignIn("Vault")).searchParams.get("state") ?? "";
    expect((await s.finishSignIn({ code: "c", state: "forged.VmF1bHQ", iss: BASE }, "Vault")).kind).toBe("stale");
    expect((await s.finishSignIn({ code: "c", state, iss: BASE }, "Vault")).kind).toBe("connected");
    expect((await s.finishSignIn({ code: "c", state, iss: BASE }, "Vault")).kind).toBe("stale");
  });

  it("hands a sign-in started in another vault to that vault, once", async () => {
    const { s } = session(() => ({ status: 200, body: {} }));
    const other = makeState(crypto, "Personal");
    expect(await s.finishSignIn({ code: "c", state: other, iss: BASE }, "Work")).toEqual({ kind: "elsewhere", vault: "Personal" });
    expect(await s.finishSignIn({ code: "c", state: other, iss: BASE, vault: "Personal" }, "Work")).toEqual({ kind: "stale" });
  });

  it("says when the person chose not to connect", async () => {
    const { s } = session(() => ({ status: 200, body: {} }));
    const state = new URL(await s.startSignIn("Vault")).searchParams.get("state") ?? "";
    expect(await s.finishSignIn({ error: "access_denied", state, iss: BASE }, "Vault")).toEqual({ kind: "declined" });
  });
});

describe("staying signed in", () => {
  it("refreshes once for many callers and saves the new refresh token first", async () => {
    let calls = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const { s, secrets, requests } = session(async () => {
      calls++;
      await gate;
      return { status: 200, body: { access_token: "syo_2", refresh_token: "syr_2", expires_in: 3600 } };
    });
    signedIn(secrets, 1_000_000 - 1);
    const all = Promise.all([s.accessToken(), s.accessToken(), s.tokenAfterRejection("syo_1")]);
    release();
    expect(await all).toEqual(["syo_2", "syo_2", "syo_2"]);
    expect(calls).toBe(1);
    expect(form(requests[0]!)).toEqual({ grant_type: "refresh_token", refresh_token: "syr_1", client_id: "synclo-obsidian", resource: "https://synclo.app/mcp" });
    expect(JSON.parse(secrets.get(SECRET_TOKENS) ?? "{}").refresh).toBe("syr_2");
  });

  it("uses the token another call already refreshed", async () => {
    const { s, secrets, requests } = session(() => ({ status: 500 }));
    signedIn(secrets, 9_999_999_999, "syr_9", "syo_new");
    expect(await s.tokenAfterRejection("syo_old")).toBe("syo_new");
    expect(requests).toHaveLength(0);
  });

  it("signs out on invalid_grant and says so", async () => {
    const { s, secrets } = session(() => ({ status: 400, body: { error: "invalid_grant", error_description: "The refresh token is no longer valid." } }));
    signedIn(secrets, 0);
    const events: Array<[boolean, string | undefined]> = [];
    s.onChange((on, why) => events.push([on, why]));
    await expect(s.accessToken()).rejects.toMatchObject({ kind: "signed-out" });
    expect(secrets.get(SECRET_TOKENS)).toBeNull();
    expect(events).toEqual([[false, "expired"]]);
  });

  it("keeps the sign-in when Synclo is briefly away", async () => {
    const { s, secrets } = session(() => ({ status: 503, body: { error: "temporarily_unavailable" } }));
    signedIn(secrets, 0);
    await expect(s.accessToken()).rejects.toBeInstanceOf(SyncloError);
    expect(secrets.get(SECRET_TOKENS)).not.toBeNull();
  });

  it("never sends tokens to a different server", async () => {
    const { http, requests } = fakeHttp(() => ({ status: 200, body: {} }));
    const secrets = memorySecrets();
    signedIn(secrets, 9_999_999_999);
    const s = new Session({ http, secrets, crypto, now: () => 0, base: () => "http://localhost:3000" });
    expect(s.isSignedIn()).toBe(false);
    await expect(s.accessToken()).rejects.toMatchObject({ kind: "signed-out" });
    expect(requests).toHaveLength(0);
  });

  it("revokes the refresh token on Disconnect and forgets it even when offline", async () => {
    const { s, secrets, requests } = session(() => {
      throw new Error("offline");
    });
    signedIn(secrets, 9_999_999_999, "syr_x");
    await s.signOut();
    expect(secrets.get(SECRET_TOKENS)).toBeNull();
    expect(form(requests[0]!)).toEqual({ token: "syr_x", client_id: "synclo-obsidian" });
  });
});
