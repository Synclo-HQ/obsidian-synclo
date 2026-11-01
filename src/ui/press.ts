import { SyncloError } from "../api/errors";

/**
 * One press of Make, named for Synclo (request_id), so pressing again after
 * a failure that may have reached Synclo finds the deck the first press
 * started instead of making (and charging for) a second. A press is kept
 * on this device for ten minutes while its outcome is unknown: pressed
 * again for the same note with the same request, even from a new window,
 * it is the same press. Anything changed, an answer either way, or ten
 * minutes, and the next press is a new one.
 */

export interface Press {
  notePath: string;
  /** The request it was made with, as a short hash. */
  requestKey: string;
  id: string;
  at: number;
}

export const PRESS_KEEP_MS = 10 * 60 * 1000;

/** A short hash of a request (cyrb53), to tell one request from another
 *  without keeping the note's words. */
export function requestKey(request: Record<string, unknown>): string {
  const text = JSON.stringify(request);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) + `.${text.length.toString(36)}`;
}

export function parsePress(raw: unknown): Press | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.notePath !== "string" || typeof o.requestKey !== "string" || typeof o.id !== "string" || typeof o.at !== "number") return null;
  return { notePath: o.notePath, requestKey: o.requestKey, id: o.id, at: o.at };
}

/** The press for this request: the one kept, if it was for the same note
 *  and request less than ten minutes ago; else a new one. */
export function pressFor(kept: Press | null, notePath: string, key: string, now: number, newId: () => string): Press {
  if (kept && kept.notePath === notePath && kept.requestKey === key && now >= kept.at && now - kept.at < PRESS_KEEP_MS) return kept;
  return { notePath, requestKey: key, id: newId(), at: now };
}

/** A failure that may have reached Synclo (no answer, or Synclo busy): the
 *  press is kept, so pressing again finds what it started. */
export function outcomeUnknown(err: unknown): boolean {
  return err instanceof SyncloError && (err.kind === "network" || err.kind === "unavailable");
}

/** 32 random letters and digits (crypto.randomUUID isn't on every phone). */
export function newPressId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
