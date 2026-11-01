import type { CardState } from "../api/card";
import { MESSAGES, SyncloError } from "../api/errors";
import type { PendingJob } from "../jobs/jobs";
import type { Timers } from "../jobs/runner";
import { askMore, changedSlide, imageKey, panelSlides, type PanelSlide } from "./model";
import { CardPoller, type StopReason } from "./poller";

/**
 * One deck as the Synclo panels see it, shared by every panel showing it:
 * one poller per generation (two panels never double the asks), the latest
 * answer, the slides, the slide that changed last, each picture's address,
 * the presentation as the job runner learned it, and why asking stopped
 * when it stopped on a refusal. It asks only while a panel showing it can
 * be seen; with no panel left, it stops asking.
 */

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
  /** Each picture's first address (kept, so a fresh signature never
   *  reloads it) and its latest (used if the first one expires). */
  private firstAddress = new Map<string, string>();
  private latestAddress = new Map<string, string>();
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
    this.ensurePoller()?.wake();
    return () => {
      this.subscribers.delete(subscriber);
      // No panel shows it any more: no more asks.
      if (!this.subscribers.size) {
        this.poller?.stop();
        this.poller = null;
      }
    };
  }

  /** A panel came into view, or Obsidian came back. */
  wake(): void {
    this.poller?.wake();
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

  /** The address to show for a picture: the first one seen for it. */
  address(image: string | null): string | null {
    return image ? (this.firstAddress.get(imageKey(image)) ?? image) : null;
  }

  /** The newest address for a picture whose address failed to load (its
   *  signature ran out); null when there is none newer. */
  fresher(failed: string): string | null {
    const key = imageKey(failed);
    const latest = this.latestAddress.get(key);
    if (!latest || latest === failed) return null;
    this.firstAddress.set(key, latest);
    return latest;
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
      visible: () => [...this.subscribers].some((s) => s.visible()),
      expired: () => this.deps.expired(this.target),
      timers: this.deps.timers,
      now: this.deps.now,
    });
    return this.poller;
  }

  private answer(card: CardState): void {
    const slides = panelSlides(card);
    for (const s of slides) {
      if (!s.image) continue;
      const key = imageKey(s.image);
      this.latestAddress.set(key, s.image);
      if (!this.firstAddress.has(key)) this.firstAddress.set(key, s.image);
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
