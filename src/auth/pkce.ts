/**
 * PKCE (RFC 7636, S256) and the sign-in's state, with the Web Crypto API
 * (works on desktop and mobile; no Node).
 */

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** base64url without padding. */
export function base64url(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += (B64[(n >> 18) & 63] ?? "") + (B64[(n >> 12) & 63] ?? "") + (B64[(n >> 6) & 63] ?? "") + (B64[n & 63] ?? "");
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] ?? 0) << 16;
    out += (B64[(n >> 18) & 63] ?? "") + (B64[(n >> 12) & 63] ?? "");
  } else if (rest === 2) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8);
    out += (B64[(n >> 18) & 63] ?? "") + (B64[(n >> 12) & 63] ?? "") + (B64[(n >> 6) & 63] ?? "");
  }
  return out;
}

export function fromBase64url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of text) {
    buffer = (buffer << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 255);
    }
  }
  return new Uint8Array(out);
}

/** A random string of `bytes` random bytes, base64url. */
export function randomToken(crypto: Crypto, bytes = 32): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return base64url(b);
}

/** The S256 challenge for a verifier. */
export async function challengeFor(crypto: Crypto, verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/**
 * The sign-in's state: random, then the vault's name, so that a return to
 * the wrong vault (Obsidian hands obsidian:// links to the vault in front)
 * can be passed to the vault that started it.
 */
export function makeState(crypto: Crypto, vaultName: string): string {
  const name = base64url(new TextEncoder().encode(vaultName.slice(0, 200)));
  return `${randomToken(crypto, 24)}.${name}`;
}

/** The vault a state was made in, or null. */
export function vaultOfState(state: string): string | null {
  const dot = state.indexOf(".");
  if (dot === -1) return null;
  const bytes = fromBase64url(state.slice(dot + 1));
  if (!bytes) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
