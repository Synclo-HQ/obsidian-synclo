import { isRecord } from "./http";
import { parseStatus, type Format, type Status } from "./synclo";

/**
 * Synclo's `card_state` answer for a generation: the deck as it is made,
 * slide by slide, with a drawing of each slide once written, then the
 * finished deck's pictures. Read defensively: a field Synclo adds later is
 * ignored, one it leaves out reads as empty.
 */

export interface CardFrame {
  /** The slide's title, as planned and then as written. */
  title: string;
  written: boolean;
  /** A drawing of the slide (an address that lasts an hour), or null. */
  pic: string | null;
}

export type DeckPictures =
  | { status: "ready"; pictures: string[] }
  | { status: "drawing"; pictures: Array<string | null> }
  | { status: "failed" };

export interface CardDocument {
  id: string;
  title: string;
  slides: number;
  titles: string[];
  editUrl: string;
}

export interface CardColors {
  slide: string;
  heading: string;
  accent: string;
}

export interface CardState {
  status: Status;
  error: { code: string; message: string } | null;
  format: Format;
  title: string | null;
  colors: CardColors | null;
  step: string | null;
  frames: CardFrame[];
  pictures: { made: number; total: number } | null;
  document: CardDocument | null;
  deck: DeckPictures | null;
}

const HEX = /^#[0-9a-f]{6}$/i;
const str = (x: unknown): string => (typeof x === "string" ? x : "");
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const url = (x: unknown): string | null => (typeof x === "string" && /^https?:\/\//i.test(x) ? x : null);

export function parseCardState(x: Record<string, unknown>): CardState {
  const frames = Array.isArray(x.frames)
    ? x.frames.filter(isRecord).map((f) => ({ title: str(f.t).trim(), written: f.s === "written", pic: url(f.pic) }))
    : [];
  const c = isRecord(x.colors) ? x.colors : null;
  const colors = c && HEX.test(str(c.slide)) && HEX.test(str(c.heading)) && HEX.test(str(c.accent)) ? { slide: str(c.slide), heading: str(c.heading), accent: str(c.accent) } : null;
  const p = isRecord(x.pictures) ? x.pictures : null;
  const pictures = p && num(p.made) !== null && num(p.total) !== null ? { made: num(p.made) ?? 0, total: num(p.total) ?? 0 } : null;
  const d = isRecord(x.document) ? x.document : null;
  const document: CardDocument | null =
    d && typeof d.id === "string" && typeof d.edit_url === "string"
      ? {
          id: d.id,
          title: str(d.title) || "Untitled",
          slides: num(d.slides) ?? 0,
          titles: Array.isArray(d.titles) ? d.titles.map((t) => str(t)) : [],
          editUrl: d.edit_url,
        }
      : null;
  const k = isRecord(x.deck) ? x.deck : null;
  let deck: DeckPictures | null = null;
  if (k?.status === "ready" && Array.isArray(k.pictures)) deck = { status: "ready", pictures: k.pictures.map((u) => url(u) ?? "").filter(Boolean) };
  else if (k?.status === "drawing" && Array.isArray(k.pictures)) deck = { status: "drawing", pictures: k.pictures.map((u) => url(u)) };
  else if (k?.status === "failed") deck = { status: "failed" };
  const e = isRecord(x.error) ? x.error : null;
  return {
    status: parseStatus(x.status),
    error: e ? { code: str(e.code) || "generation_failed", message: str(e.message) } : null,
    format: x.format === "document" ? "document" : "slides",
    title: typeof x.title === "string" && x.title.trim() ? x.title.trim() : null,
    colors,
    step: typeof x.step === "string" ? x.step : null,
    frames,
    pictures,
    document,
    deck,
  };
}
