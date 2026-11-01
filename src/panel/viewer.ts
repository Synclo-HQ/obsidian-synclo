import { parseJobs, type PendingJob } from "../jobs/jobs";

/**
 * The deck viewer's pure parts: which slide a key or a step lands on, how
 * large the slide is drawn in the room it has, and the state a tab keeps
 * across a restart. Tested without Obsidian.
 */

/** A slide index inside the deck: 0 for an empty deck, else 0 to count-1. */
export function clampSlide(index: number, count: number): number {
  if (count <= 0 || !Number.isFinite(index)) return 0;
  return Math.min(count - 1, Math.max(0, Math.trunc(index)));
}

/** The slide a key moves to, or null when the key isn't one of the
 *  viewer's: arrows and Page Up/Down step (stopping at the ends), Home and
 *  End go to the first and the last. */
export function keyStep(key: string, at: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowLeft":
    case "PageUp":
      return clampSlide(at - 1, count);
    case "ArrowRight":
    case "PageDown":
      return clampSlide(at + 1, count);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

export interface Size {
  w: number;
  h: number;
}

/** A slide's shape before its picture says otherwise. */
export const SLIDE_ASPECT = 16 / 9;

/** The size to draw a slide at: as large as fits the room, in the
 *  picture's own shape (16:9 until it is known), never larger than the
 *  picture itself (nor than `cap`, the deck's pictures' size, before it
 *  has loaded). Whole pixels. */
export function fitBox(room: Size, natural: Size | null, cap: Size | null = null): Size {
  const own = natural && natural.w > 0 && natural.h > 0 ? natural : null;
  const aspect = own ? own.w / own.h : SLIDE_ASPECT;
  if (!(room.w > 0) || !(room.h > 0)) return { w: 0, h: 0 };
  let w = Math.min(room.w, room.h * aspect);
  const limit = own ?? (cap && cap.w > 0 ? cap : null);
  if (limit) w = Math.min(w, limit.w);
  const width = Math.max(0, Math.floor(w));
  return { w: width, h: Math.max(0, Math.floor(width / aspect + 1e-6)) };
}

/** What a viewer tab keeps across a restart: the deck (as the job that
 *  made it) and the slide shown. */
export interface DeckViewState {
  job: PendingJob;
  slide: number;
}

export function deckStateRecord(state: DeckViewState): Record<string, unknown> {
  const { job, slide } = state;
  return {
    generationId: job.generationId,
    notePath: job.notePath,
    title: job.title,
    format: job.format,
    base: job.base,
    startedAt: job.startedAt,
    ...(job.workspace ? { workspace: { ...job.workspace } } : {}),
    slide,
  };
}

/** A viewer's kept state, or null when it doesn't name a deck. */
export function deckStateOf(raw: unknown): DeckViewState | null {
  const job = parseJobs([raw])[0];
  if (!job) return null;
  const slide = (raw as Record<string, unknown>).slide;
  return { job, slide: typeof slide === "number" ? clampSlide(slide, Number.MAX_SAFE_INTEGER) : 0 };
}

/** A sideways swipe's direction: 1 to the next slide, -1 to the previous,
 *  0 when it was too short or more up and down than across. */
export function swipeStep(dx: number, dy: number, min = 40): number {
  if (Math.abs(dx) < min || Math.abs(dx) < 1.5 * Math.abs(dy)) return 0;
  return dx < 0 ? 1 : -1;
}
