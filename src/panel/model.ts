import type { CardState } from "../api/card";

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
 *  slide's drawing as it is written; once ready, the finished deck's
 *  pictures (with its images) replace them, slide by slide as they come. */
export function panelSlides(card: CardState): PanelSlide[] {
  const titles = card.document?.titles.length ? card.document.titles : card.frames.map((f) => f.title);
  const finished = card.deck && card.deck.status !== "failed" ? card.deck.pictures : [];
  const count = Math.max(titles.length, card.frames.length);
  const slides: PanelSlide[] = [];
  for (let i = 0; i < count; i++) {
    const title = titles[i] || card.frames[i]?.title || "";
    slides.push({ title, image: finished[i] || card.frames[i]?.pic || null });
  }
  return slides;
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

/** How far the bar is filled, 0 to 1; null before the plan (the bar then
 *  runs without a measure). The slides being written make most of it,
 *  then their images, then finishing. */
export function progressShare(card: CardState): number | null {
  if (card.status === "completed") return 1;
  const total = card.frames.length;
  if (!total) return null;
  const written = card.frames.filter((f) => f.written).length;
  if (written === 0) return 0.04;
  const pics = card.pictures;
  const images = pics && pics.total > 0 ? Math.min(1, pics.made / pics.total) : written >= total ? 1 : 0;
  const finishing = written >= total && images >= 1 ? 0.04 : 0;
  return Math.min(1, 0.04 + 0.66 * (written / total) + 0.26 * images + finishing);
}

/** Asks after the deck is ready, while its pictures are drawn. */
export const MAX_ASKS_WHEN_DONE = 25;
/** Between asks while the deck is made. */
export const ASK_EVERY_MS = 2_500;

/** When to ask again: in milliseconds, or null to stop. While the deck is
 *  made, every 2.5 s; once ready, at once while its pictures are drawn
 *  (Synclo holds each ask while it draws), up to a limit. */
export function nextAsk(card: CardState, asksWhenDone: number): number | null {
  if (card.status === "queued" || card.status === "running") return ASK_EVERY_MS;
  if (card.status === "failed") return null;
  if (!card.deck || card.deck.status !== "drawing") return null;
  return asksWhenDone < MAX_ASKS_WHEN_DONE ? 0 : null;
}
