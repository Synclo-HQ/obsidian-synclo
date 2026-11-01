/**
 * What can go wrong talking to Synclo, sorted by what the person can do
 * about it. Messages are written for people, not developers.
 */

export type FailureKind =
  /** Not connected, or the sign-in ended: connect again. */
  | "signed-out"
  /** Synclo answered 503 or 5xx: try again shortly; the sign-in is kept. */
  | "unavailable"
  /** No answer at all: offline, or too slow. */
  | "network"
  /** Too many requests: wait. */
  | "rate-limited"
  /** The request is larger than Synclo takes. */
  | "too-large"
  /** Synclo refused this request (out of credits, bad arguments, …). */
  | "rejected";

export class SyncloError extends Error {
  readonly kind: FailureKind;
  /** Synclo's error code, when it gave one (insufficient_credits, …). */
  readonly code: string | undefined;
  /** Seconds to wait, for rate-limited. */
  readonly retryAfter: number | undefined;
  readonly extra: Record<string, unknown>;

  constructor(kind: FailureKind, message: string, options: { code?: string; retryAfter?: number; extra?: Record<string, unknown> } = {}) {
    super(message);
    this.name = "SyncloError";
    this.kind = kind;
    this.code = options.code;
    this.retryAfter = options.retryAfter;
    this.extra = options.extra ?? {};
  }
}

export const MESSAGES = {
  signedOut: "Connect Synclo to continue. You'll find Connect in the plugin's settings.",
  signInEnded: "Your Synclo sign-in has ended. Connect again to keep going.",
  unavailable: "Synclo is briefly unavailable. Try again in a moment.",
  network: "Synclo couldn't be reached. Check your connection and try again.",
  rateLimited: "Synclo is getting a lot of requests from this connection. Try again in a few minutes.",
  outOfCredits: "This workspace is out of credits. Get more at synclo.app to keep making presentations. Opening, finding and downloading your presentations still work.",
  tooManyRunning: "Synclo is already making two presentations for this workspace. Try again when one of them is ready.",
} as const;

/** The words to show for any error the plugin meets. */
export function messageFor(error: unknown): string {
  if (error instanceof SyncloError) {
    if (error.kind === "signed-out") return error.message || MESSAGES.signedOut;
    if (error.kind === "unavailable") return MESSAGES.unavailable;
    if (error.kind === "network") return MESSAGES.network;
    if (error.kind === "rate-limited") return MESSAGES.rateLimited;
    if (error.code === "insufficient_credits") return MESSAGES.outOfCredits;
    if (error.code === "too_many_running") return MESSAGES.tooManyRunning;
    return error.message;
  }
  return "Something went wrong. Try again in a moment.";
}

export function isOutOfCredits(error: unknown): boolean {
  return error instanceof SyncloError && error.code === "insufficient_credits";
}
