import type { CardState } from "../api/card";
import type { ProgressInput } from "../jobs/jobs";

/**
 * What the Synclo panel shows, worked out from Synclo's `card_state`
 * answers: the slides (each with its drawing once there is one), which
 * slide the large frame shows, how far along the bar is, and when to stop
 * asking. Pure, so it is tested without Obsidian.
 */

export interface PanelSlide {
  title: string;
  /** The slide's picture to show (an address), or null for its sketch. */
  image: string | null;
}

/** The slides as the panel draws them. While the deck is made, each
 *  slide's drawing as it is written. Once the presentation exists, its own
 *  count and titles, with the finished deck's pictures (which have its
 *  images) as they come; a drawing made while writing stands in only when
 *  it is plainly the same slide (same place, same title), so a title is
 *  never paired with another slide's picture. */
export function panelSlides(card: CardState): PanelSlide[] {
  const finished = card.deck && card.deck.status !== "failed" ? card.deck.pictures : [];
  const doc = card.document;
  if (doc) {
    const count = doc.slides > 0 ? doc.slides : doc.titles.length;
    const slides: PanelSlide[] = [];
    for (let i = 0; i < count; i++) {
      const title = doc.titles[i] ?? "";
      const frame = card.frames[i];
      const drawing = frame?.pic && sameTitle(frame.title, title) ? frame.pic : null;
      slides.push({ title, image: finished[i] ?? drawing ?? null });
    }
    return slides;
  }
  return card.frames.map((f) => ({ title: f.title, image: f.pic }));
}

function sameTitle(a: string, b: string): boolean {
  const key = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  return key(a) === key(b);
}

/** A picture's address without its signature: Synclo signs the same
 *  picture anew on every answer, so this is what says it changed. */
export function imageKey(address: string): string {
  const q = address.indexOf("?");
  return q === -1 ? address : address.slice(0, q);
}

/** The slide whose picture changed between two answers (the last one in
 *  the deck when several did), or null. */
export function changedSlide(before: PanelSlide[], after: PanelSlide[]): number | null {
  let changed: number | null = null;
  after.forEach((s, i) => {
    const was = before[i]?.image ?? null;
    if (s.image && (!was || imageKey(was) !== imageKey(s.image))) changed = i;
  });
  return changed;
}

/** The slide the large frame shows: once ready, the one picked (else the
 *  first); while it is made, a picked slide that has its drawing, else the
 *  slide that changed last. */
export function heroSlide(slides: PanelSlide[], lastChanged: number | null, picked: number | null, ready: boolean): number | null {
  if (!slides.length) return null;
  if (ready) return picked !== null && picked < slides.length ? picked : 0;
  if (picked !== null && slides[picked]?.image) return picked;
  if (lastChanged !== null && lastChanged < slides.length) return lastChanged;
  return 0;
}

/** Where a generation stands, from the panel's answer. */
export function cardProgressInput(card: CardState): ProgressInput {
  return {
    status: card.status,
    title: card.title,
    step: card.step,
    started: card.step !== null || card.frames.length > 0,
    total: card.frames.length,
    written: card.frames.filter((f) => f.written).length,
    slideTitles: card.frames.map((f) => f.title),
    pictures: card.pictures,
  };
}

/** How far the bar is filled, 0 to 1; null before the plan (the bar then
 *  runs without a measure). The slides being written make most of it,
 *  then their images, then finishing. */
export function progressShare(card: CardState): number | null {
  return shareOf(cardProgressInput(card));
}

/** The bar's fill for where a generation stands, from either answer. */
export function shareOf(input: ProgressInput): number | null {
  if (input.status === "completed") return 1;
  const total = input.total;
  if (!total) return null;
  const written = Math.min(input.written, total);
  if (written === 0) return 0.04;
  const pics = input.pictures;
  const images = pics && pics.total > 0 ? Math.min(1, pics.made / pics.total) : written >= total ? 1 : 0;
  const finishing = written >= total && images >= 1 ? 0.04 : 0;
  return Math.min(1, 0.04 + 0.66 * (written / total) + 0.26 * images + finishing);
}

/** Asks after the deck is ready, while its pictures are drawn. */
export const MAX_ASKS_WHEN_DONE = 25;
/** Between asks while the deck is made. */
export const ASK_EVERY_MS = 2_500;
/** Before asking once more for the finished deck's pictures, when drawing
 *  them failed. */
export const RETRY_FAILED_PICTURES_MS = 60_000;

export interface AskState {
  /** Asks made since the deck was finished. */
  asksWhenDone: number;
  /** Asks again for finished pictures that failed (one is allowed). */
  pictureRetries: number;
  /** The job is past its time, or the job runner has given up on it. */
  expired: boolean;
}

/** There is more to ask about a deck shown so far as `card` (nothing
 *  known yet, still being made, or its pictures still drawn). */
export function askMore(card: CardState | null): boolean {
  return card === null || nextAsk(card, { asksWhenDone: 0, pictureRetries: 0, expired: false }) !== null;
}

/** When to ask again: in milliseconds, or null to stop. While the deck is
 *  made, every 2.5 s (unless it is past its time: then this ask was the
 *  last); once ready, at once while its pictures are drawn (Synclo holds
 *  each ask while it draws), up to a limit; pictures that failed are asked
 *  for once more, a minute later. */
export function nextAsk(card: CardState, state: AskState): number | null {
  if (card.status === "queued" || card.status === "running") return state.expired ? null : ASK_EVERY_MS;
  if (card.status === "failed" || card.gone || !card.deck) return null;
  if (card.deck.status === "failed") return state.pictureRetries < 1 ? RETRY_FAILED_PICTURES_MS : null;
  if (card.deck.status !== "drawing") return null;
  return state.asksWhenDone < MAX_ASKS_WHEN_DONE ? 0 : null;
}
