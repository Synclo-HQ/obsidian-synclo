import { SyncloError, messageFor } from "../api/errors";
import type { Generation } from "../api/synclo";
import type { JobStore, PendingJob } from "./jobs";

/**
 * Follows each presentation being made until Synclo says it is ready or
 * failed. Synclo holds each check open for a while (wait_seconds), so a
 * check is a long wait, not a busy loop. A check that never answers (a
 * phone that paused the app; requestUrl can't be stopped) is given up on
 * after its time, or at once when Obsidian comes back to the front.
 */

export interface RunnerEvents {
  progress(job: PendingJob, gen: Generation): void;
  ready(job: PendingJob, gen: Generation): Promise<void> | void;
  failed(job: PendingJob, error: { code: string; message: string }): void;
  /** The sign-in ended; the job waits until the person connects again. */
  signedOut(job: PendingJob): void;
  /** A check failed for a reason that may pass (offline, Synclo busy). */
  trouble(job: PendingJob, error: unknown): void;
}

export interface Timers {
  set(fn: () => void, ms: number): number;
  clear(id: number): void;
}

export interface RunnerDeps {
  generation(id: string, waitSeconds: number): Promise<Generation>;
  store: JobStore;
  events: RunnerEvents;
  timers: Timers;
  now: () => number;
  base: () => string;
  isSignedIn: () => boolean;
  /** How long Synclo should hold each check open. */
  waitSeconds: () => number;
}

/** A job older than this is given up on (Synclo stops one at 15 minutes). */
export const GIVE_UP_MS = 3 * 60 * 60 * 1000;
const FIRST_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;
/** A check this old is abandoned when Obsidian comes back to the front. */
const STALE_CHECK_MS = 10_000;

interface Loop {
  checkStartedAt: number | null;
  abandon: (() => void) | null;
  wake: (() => void) | null;
}

export class JobRunner {
  private jobs: PendingJob[];
  private loops = new Map<string, Loop>();
  private stopped = false;

  constructor(private readonly deps: RunnerDeps) {
    this.jobs = deps.store.load();
  }

  list(): PendingJob[] {
    return [...this.jobs];
  }

  /** Starts following a new job (once, even if added twice). */
  add(job: PendingJob): void {
    if (!this.jobs.some((j) => j.generationId === job.generationId)) {
      this.jobs.push(job);
      this.persist();
    }
    void this.follow(job.generationId);
  }

  /** Follows every saved job for this server (on start, after connecting). */
  resumeAll(): void {
    for (const j of this.jobs) if (j.base === this.deps.base()) void this.follow(j.generationId);
  }

  /** Obsidian came back to the front or back online: check now. */
  kick(): void {
    const now = this.deps.now();
    for (const loop of this.loops.values()) {
      if (loop.checkStartedAt !== null && now - loop.checkStartedAt > STALE_CHECK_MS) loop.abandon?.();
      loop.wake?.();
    }
  }

  /** A note was renamed or moved: the link goes to its new path. */
  renamed(oldPath: string, newPath: string): void {
    let changed = false;
    for (const j of this.jobs) {
      if (j.notePath === oldPath) {
        j.notePath = newPath;
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  stop(): void {
    this.stopped = true;
    for (const loop of this.loops.values()) {
      loop.abandon?.();
      loop.wake?.();
    }
    this.loops.clear();
  }

  private job(id: string): PendingJob | undefined {
    return this.jobs.find((j) => j.generationId === id);
  }

  private remove(id: string): void {
    this.jobs = this.jobs.filter((j) => j.generationId !== id);
    this.persist();
  }

  private persist(): void {
    this.deps.store.save(this.jobs);
  }

  private async follow(id: string): Promise<void> {
    if (this.loops.has(id) || this.stopped) return;
    const loop: Loop = { checkStartedAt: null, abandon: null, wake: null };
    this.loops.set(id, loop);
    let backoff = 0;
    try {
      for (;;) {
        const job = this.job(id);
        if (!job || this.stopped || job.base !== this.deps.base()) return;
        if (!this.deps.isSignedIn()) {
          this.deps.events.signedOut(job);
          return;
        }
        if (this.deps.now() - job.startedAt > GIVE_UP_MS) {
          this.remove(id);
          this.deps.events.failed(job, { code: "timed_out", message: "Synclo didn't finish this presentation. Try making it again." });
          return;
        }
        let gen: Generation | "abandoned";
        try {
          loop.checkStartedAt = this.deps.now();
          gen = await Promise.race([
            this.deps.generation(id, this.deps.waitSeconds()),
            new Promise<"abandoned">((resolve) => (loop.abandon = () => resolve("abandoned"))),
          ]);
        } catch (err) {
          if (this.stopped || !this.job(id)) return;
          if (err instanceof SyncloError && err.kind === "signed-out") {
            this.deps.events.signedOut(job);
            return;
          }
          if (err instanceof SyncloError && err.kind === "rejected") {
            this.remove(id);
            this.deps.events.failed(job, {
              code: err.code ?? "rejected",
              message: err.code === "not_found" ? "This presentation can't be found in your Synclo workspace any more." : messageFor(err),
            });
            return;
          }
          this.deps.events.trouble(job, err);
          const retryAfter = err instanceof SyncloError && err.kind === "rate-limited" ? (err.retryAfter ?? 60) * 1000 : 0;
          backoff = backoff ? Math.min(MAX_BACKOFF_MS, backoff * 2) : FIRST_BACKOFF_MS;
          await this.pause(loop, Math.max(backoff, retryAfter));
          continue;
        } finally {
          loop.checkStartedAt = null;
          loop.abandon = null;
        }
        if (this.stopped || !this.job(id)) return;
        if (gen === "abandoned") continue;
        backoff = 0;
        if (gen.status === "completed") {
          this.remove(id);
          await this.deps.events.ready(job, gen);
          return;
        }
        if (gen.status === "failed") {
          this.remove(id);
          this.deps.events.failed(job, gen.error ?? { code: "generation_failed", message: "The presentation couldn't be made." });
          return;
        }
        this.deps.events.progress(job, gen);
        // Synclo already held the check open; a short breath before the next.
        await this.pause(loop, gen.status === "queued" ? 3_000 : 1_000);
      }
    } finally {
      if (this.loops.get(id) === loop) this.loops.delete(id);
    }
  }

  private pause(loop: Loop, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        this.deps.timers.clear(timer);
        loop.wake = null;
        resolve();
      };
      const timer = this.deps.timers.set(done, ms);
      loop.wake = done;
    });
  }
}
