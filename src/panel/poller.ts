import { SyncloError } from "../api/errors";
import type { CardState } from "../api/card";
import { TIMED_OUT_MESSAGE, type Timers } from "../jobs/runner";
import { nextAsk, type AskState } from "./model";

/**
 * Asks Synclo how a deck looks, for the panel: one ask at a time, again
 * after the delay the answer calls for, never while no panel showing it
 * can be seen, backing off after a failure as the job runner does. It
 * stops for good when there is nothing more to show, and says why when
 * that is a refusal (the panel then shows it): signed out, the deck isn't
 * there (or is another workspace's), the connection lacks the right, or
 * the deck is past its time (or the job runner gave up on it) and Synclo
 * still says it is being made, after one last ask.
 * A fresh poller starts over (after a sign-in, or when the job runner
 * says the deck is ready).
 */

export type StopReason = "signed-out" | "gone" | "scope" | "expired";

export interface PollerDeps {
  ask: () => Promise<CardState>;
  onAnswer: (card: CardState) => void;
  /** Asking stopped on a refusal. */
  onStop: (reason: StopReason, error: SyncloError) => void;
  /** A panel showing this deck is on screen and Obsidian is in front. */
  visible: () => boolean;
  /** The job is past its time, or the job runner has given up on it. */
  expired: () => boolean;
  timers: Timers;
  now: () => number;
}

const FIRST_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;
/** An ask older than this when the panel comes back into view is given
 *  up (a phone that paused Obsidian may never finish it). */
const STALE_ASK_MS = 15_000;

export class CardPoller {
  /** The ask in flight: when it started, and its number (an abandoned
   *  ask's answer is ignored). */
  private inFlight: { since: number; n: number } | null = null;
  private asks = 0;
  private stopped = false;
  private done = false;
  private timer: number | null = null;
  private backoff = 0;
  private state: AskState = { asksWhenDone: 0, pictureRetries: 0, expired: false };

  constructor(private readonly deps: PollerDeps) {}

  /** Asks now if asking had paused (the panel opened, came into view, or
   *  Obsidian came back). An ask already due later keeps its time, so the
   *  panel coming into view never asks faster than the pace; an ask in
   *  flight for too long is given up and asked again. */
  wake(): void {
    if (this.stopped || this.done) return;
    if (this.inFlight) {
      if (this.deps.now() - this.inFlight.since <= STALE_ASK_MS) return;
      this.inFlight = null;
    }
    if (this.timer !== null) return;
    void this.ask();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
  }

  /** Nothing more to ask (the deck is shown in full, or there is nothing
   *  to show). */
  get finished(): boolean {
    return this.done;
  }

  private clearTimer(): void {
    if (this.timer !== null) this.deps.timers.clear(this.timer);
    this.timer = null;
  }

  private later(ms: number): void {
    this.clearTimer();
    this.timer = this.deps.timers.set(() => {
      this.timer = null;
      void this.ask();
    }, ms);
  }

  private finish(reason?: StopReason, error?: SyncloError): void {
    this.done = true;
    this.clearTimer();
    if (reason && error) this.deps.onStop(reason, error);
  }

  private async ask(): Promise<void> {
    if (this.stopped || this.done || this.inFlight) return;
    // Out of sight, nothing is asked; wake() asks once it is seen again.
    if (!this.deps.visible()) return;
    const mine = { since: this.deps.now(), n: ++this.asks };
    this.inFlight = mine;
    let card: CardState;
    try {
      card = await this.deps.ask();
    } catch (err) {
      if (this.inFlight !== mine) return;
      this.inFlight = null;
      if (this.stopped) return;
      if (err instanceof SyncloError && err.kind === "signed-out") return this.finish("signed-out", err);
      if (err instanceof SyncloError && err.kind === "rejected") {
        if (err.code === "insufficient_scope") return this.finish("scope", err);
        // Synclo's own failure is tried again; any other refusal means the
        // deck isn't there for this account.
        if (err.code !== "server_error") return this.finish("gone", err);
      }
      const retryAfter = err instanceof SyncloError && err.kind === "rate-limited" ? (err.retryAfter ?? 60) * 1000 : 0;
      this.backoff = this.backoff ? Math.min(MAX_BACKOFF_MS, this.backoff * 2) : FIRST_BACKOFF_MS;
      this.later(Math.max(this.backoff, retryAfter));
      return;
    }
    // An answer to an ask given up on: the fresh ask answers instead.
    if (this.inFlight !== mine) return;
    this.inFlight = null;
    if (this.stopped) return;
    this.backoff = 0;
    this.deps.onAnswer(card);
    if (card.status === "completed") this.state.asksWhenDone++;
    this.state.expired = this.deps.expired();
    const next = nextAsk(card, this.state);
    if (card.status === "completed" && card.deck?.status === "failed" && next !== null) this.state.pictureRetries++;
    if (next === null) {
      if ((card.status === "queued" || card.status === "running") && this.state.expired) return this.finish("expired", new SyncloError("rejected", TIMED_OUT_MESSAGE, { code: "timed_out" }));
      return this.finish();
    }
    this.later(next);
  }
}
