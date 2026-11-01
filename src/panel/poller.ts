import { SyncloError } from "../api/errors";
import type { CardState } from "../api/card";
import type { Timers } from "../jobs/runner";
import { nextAsk } from "./model";

/**
 * Asks Synclo how a deck looks, for the panel: one ask at a time, again
 * after the delay the answer calls for, never while the panel can't be
 * seen, backing off after a failure as the job runner does. Stops for
 * good when the answer says there is nothing more to show, or when the
 * generation isn't there.
 */

export interface PollerDeps {
  ask: () => Promise<CardState>;
  onAnswer: (card: CardState) => void;
  /** The panel is on screen and Obsidian is in front. */
  visible: () => boolean;
  timers: Timers;
}

const FIRST_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;

export class CardPoller {
  private inFlight = false;
  private stopped = false;
  private done = false;
  private timer: number | null = null;
  private backoff = 0;
  private asksWhenDone = 0;

  constructor(private readonly deps: PollerDeps) {}

  /** Asks now if asking had paused (the panel opened, came into view, or
   *  Obsidian came back). An ask already due later keeps its time, so
   *  the panel coming into view never asks faster than the pace. */
  wake(): void {
    if (this.stopped || this.done || this.inFlight || this.timer !== null) return;
    void this.ask();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
  }

  /** Nothing more to ask (the deck is shown in full, or gone). */
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

  private async ask(): Promise<void> {
    if (this.stopped || this.done || this.inFlight) return;
    // Out of sight, nothing is asked; wake() asks once it is seen again.
    if (!this.deps.visible()) return;
    this.inFlight = true;
    let card: CardState;
    try {
      card = await this.deps.ask();
    } catch (err) {
      this.inFlight = false;
      if (this.stopped) return;
      // Gone, or not this account's: there is nothing to show. Signed out:
      // the panel asks again once a sign-in wakes it.
      if (err instanceof SyncloError && (err.kind === "signed-out" || (err.kind === "rejected" && err.code !== "server_error"))) {
        if (err.kind === "rejected") this.done = true;
        return;
      }
      const retryAfter = err instanceof SyncloError && err.kind === "rate-limited" ? (err.retryAfter ?? 60) * 1000 : 0;
      this.backoff = this.backoff ? Math.min(MAX_BACKOFF_MS, this.backoff * 2) : FIRST_BACKOFF_MS;
      this.later(Math.max(this.backoff, retryAfter));
      return;
    }
    this.inFlight = false;
    if (this.stopped) return;
    this.backoff = 0;
    this.deps.onAnswer(card);
    if (card.status === "completed") this.asksWhenDone++;
    const next = nextAsk(card, this.asksWhenDone);
    if (next === null) {
      this.done = true;
      return;
    }
    this.later(next);
  }
}
