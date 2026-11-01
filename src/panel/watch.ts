import type { CardState } from "../api/card";
import { MESSAGES, SyncloError } from "../api/errors";
import type { PendingJob } from "../jobs/jobs";
import type { Timers } from "../jobs/runner";
import { askMore, changedSlide, imageKey, panelSlides, type PanelSlide } from "./model";
import { CardPoller, type StopReason } from "./poller";

/**
 * One deck as the Synclo panels and deck viewers see it, shared by every
 * view showing it: one poller per generation (two views never double the
 * asks), the latest answer, the slides, the slide that changed last, each
 * picture's address, the presentation as the job runner learned it, and
 * why asking stopped when it stopped on a refusal. It asks only while a
 * view showing it can be seen; with none left, it stops asking. Picture
 * addresses last an hour: a view seen again after 45 minutes asks again.
 */

/** How long a picture's address is used before a newer one is. */
export const ADDRESS_FRESH_MS = 45 * 60 * 1000;

interface Address {
  address: string;
  /** When Synclo gave it. */
  at: number;
}

export interface WatchSubscriber {
  /** The deck changed: draw it again. */
  changed(): void;
  /** This panel is on screen. */
  visible(): boolean;
}

export interface WatchDeps {
  ask: (generationId: string) => Promise<CardState>;
  /** Every answer, for the progress board. */
  onCard: (generationId: string, card: CardState) => void;
  /** The job is past its time, or the job runner has given up on it. */
  expired: (target: PendingJob) => boolean;
  signedIn: () => boolean;
  timers: Timers;
  now: () => number;
}

export interface Stopped {
  reason: StopReason;
  error: SyncloError;
}

/** The presentation as the job runner learned it. */
export interface RunnerDocument {
  id: string;
  title: string;
  slides: number;
  editUrl: string;
}

export class DeckWatch {
  card: CardState | null = null;
  slides: PanelSlide[] = [];
  lastChanged: number | null = null;
  /** Asking stopped on a refusal: what the panel says instead. */
  stopped: Stopped | null = null;
  /** The presentation as the job runner learned it, for when the panel's
   *  own answer doesn't say so yet. */
  runnerDocument: RunnerDocument | null = null;
  /** When Synclo last answered. */
  answeredAt: number | null = null;
  /** Each picture's address in use (kept, so a fresh signature never
   *  reloads it, until it nears its end) and its latest. */
  private firstAddress = new Map<string, Address>();
  private latestAddress = new Map<string, Address>();
  private subscribers = new Set<WatchSubscriber>();
  private poller: CardPoller | null = null;

  constructor(
    readonly target: PendingJob,
    private readonly deps: WatchDeps,
  ) {}

  /** A panel shows this deck; the returned function is called when it no
   *  longer does. */
  subscribe(subscriber: WatchSubscriber): () => void {
    this.subscribers.add(subscriber);
    this.ensurePoller();
    this.wake();
    return () => {
      this.subscribers.delete(subscriber);
      // No panel shows it any more: no more asks.
      if (!this.subscribers.size) {
        this.poller?.stop();
        this.poller = null;
      }
    };
  }

  /** A view showing it opened, came into view, or Obsidian came back:
   *  asks now if asking had paused, and asks afresh when the last answer's
   *  picture addresses are nearing their end. */
  wake(): void {
    const answeredAt = this.answeredAt;
    if (answeredAt !== null && this.deps.now() - answeredAt > ADDRESS_FRESH_MS && this.seen()) {
      // Once: the next answer says when again.
      this.answeredAt = null;
      this.restart();
      return;
    }
    this.poller?.wake();
  }

  /** A view shows this deck (it is worth keeping). */
  get inUse(): boolean {
    return this.subscribers.size > 0;
  }

  /** Starts asking afresh (after a sign-in or a sign-out, or when the job
   *  runner says the deck is ready): a stopped or backing-off poller is
   *  replaced. */
  restart(): void {
    this.poller?.stop();
    this.poller = null;
    this.stopped = null;
    this.ensurePoller()?.wake();
    this.notify();
  }

  /** No more asks, for good (the plugin unloads). */
  stop(): void {
    this.poller?.stop();
    this.poller = null;
    this.subscribers.clear();
  }

  /** The job runner's word that the deck is ready, with its presentation. */
  setRunnerDocument(doc: RunnerDocument | null): void {
    this.runnerDocument = doc;
    this.notify();
  }

  /** The address to show for a picture: the first one seen for it, until
   *  it nears the end of its hour; then the newest, kept from then on. */
  address(image: string | null): string | null {
    if (!image) return null;
    const key = imageKey(image);
    const first = this.firstAddress.get(key);
    if (!first) return image;
    if (this.deps.now() - first.at <= ADDRESS_FRESH_MS) return first.address;
    const latest = this.latestAddress.get(key);
    if (latest && latest.at > first.at) {
      this.firstAddress.set(key, latest);
      return latest.address;
    }
    return first.address;
  }

  /** The newest address for a picture whose address failed to load (its
   *  signature ran out); null when there is none newer. */
  fresher(failed: string): string | null {
    const key = imageKey(failed);
    const latest = this.latestAddress.get(key);
    if (!latest || latest.address === failed) return null;
    this.firstAddress.set(key, latest);
    return latest.address;
  }

  /** A view showing it is on screen. */
  private seen(): boolean {
    return [...this.subscribers].some((s) => s.visible());
  }

  /** The poller, made if a panel shows the deck and none is running; null
   *  when there is no panel, or no sign-in to ask with. */
  private ensurePoller(): CardPoller | null {
    if (this.poller || !this.subscribers.size) return this.poller;
    if (!this.deps.signedIn()) {
      // Nothing can be asked until the person connects again: said, unless
      // there is nothing more to ask.
      if (askMore(this.card)) this.stopped = { reason: "signed-out", error: new SyncloError("signed-out", MESSAGES.signedOut) };
      return null;
    }
    this.poller = new CardPoller({
      ask: () => this.deps.ask(this.target.generationId),
      onAnswer: (card) => this.answer(card),
      onStop: (reason, error) => {
        this.stopped = { reason, error };
        this.notify();
      },
      visible: () => this.seen(),
      expired: () => this.deps.expired(this.target),
      timers: this.deps.timers,
      now: this.deps.now,
    });
    return this.poller;
  }

  private answer(card: CardState): void {
    const slides = panelSlides(card);
    const at = this.deps.now();
    this.answeredAt = at;
    for (const s of slides) {
      if (!s.image) continue;
      const key = imageKey(s.image);
      this.latestAddress.set(key, { address: s.image, at });
      if (!this.firstAddress.has(key)) this.firstAddress.set(key, { address: s.image, at });
    }
    const changed = changedSlide(this.slides, slides);
    if (changed !== null) this.lastChanged = changed;
    this.card = card;
    this.slides = slides;
    this.deps.onCard(this.target.generationId, card);
    this.notify();
  }

  private notify(): void {
    for (const s of this.subscribers) s.changed();
  }
}
