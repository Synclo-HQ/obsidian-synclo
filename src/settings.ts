import { DEFAULT_BASE } from "./auth/oauth";
import type { Format } from "./api/synclo";

/**
 * What the person chose as defaults (saved in the plugin's data.json, in
 * the vault). No sign-in, token or note text is ever kept here.
 */
export interface SyncloSettings {
  /** The Synclo server (Advanced; for development). */
  base: string;
  format: Format;
  /** Slides (or sections) at most. */
  slides: number;
  /** Keep the note's words as written (preserve), or let Synclo tighten
   *  them (condense). */
  keepWords: boolean;
  /** A theme id, or "" for a look Synclo designs for the note. */
  theme: string;
  /** A picture style id, or "theme". */
  imageStyle: string;
  includeLinked: boolean;
  /** Where downloaded files are saved. */
  saveTo: "note-folder" | "attachments";
}

export const DEFAULT_SETTINGS: SyncloSettings = {
  base: DEFAULT_BASE,
  format: "slides",
  slides: 8,
  keepWords: false,
  theme: "",
  imageStyle: "theme",
  includeLinked: false,
  saveTo: "note-folder",
};

/** Synclo's picture styles (its image-styles list), by the names its app
 *  shows. */
export const IMAGE_STYLES: Array<[id: string, label: string]> = [
  ["theme", "Match the theme"],
  ["photo", "True to life"],
  ["lifestyle", "Bright and candid"],
  ["cinematic", "Golden hour"],
  ["black-white", "Black and white"],
  ["still-life", "Product close-up"],
  ["illustration", "Flat vector"],
  ["picture-book", "Picture book"],
  ["watercolor", "Watercolor"],
  ["isometric", "Isometric"],
  ["flat-line", "Line art"],
  ["ink-sketch", "Ink sketch"],
  ["3d", "Soft 3D"],
  ["paper-cutout", "Paper cut"],
  ["felt", "Felt"],
  ["bold-poster", "Screen-print poster"],
  ["bauhaus", "Bauhaus"],
  ["magazine-cutout", "Collage"],
  ["neon-glow", "Neon"],
  ["waves", "Silk waves"],
  ["liquid-glass", "Liquid glass"],
  ["paint-swirl", "Paint swirl"],
];

/** The lengths offered, up to what the plan allows at a time. */
export function lengthOptions(planMax: number | null, current: number): number[] {
  const max = planMax ?? 10;
  const options = [3, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50].filter((n) => n <= max);
  if (!options.includes(max) && max >= 1) options.push(max);
  if (current <= max && !options.includes(current)) options.push(current);
  return options.sort((a, b) => a - b);
}

export function parseSettings(raw: unknown): SyncloSettings {
  const s = { ...DEFAULT_SETTINGS };
  if (typeof raw !== "object" || raw === null) return s;
  const r = raw as Record<string, unknown>;
  if (typeof r.base === "string" && r.base.trim()) s.base = r.base;
  if (r.format === "slides" || r.format === "document") s.format = r.format;
  if (typeof r.slides === "number" && Number.isInteger(r.slides) && r.slides >= 1 && r.slides <= 100) s.slides = r.slides;
  if (typeof r.keepWords === "boolean") s.keepWords = r.keepWords;
  if (typeof r.theme === "string") s.theme = r.theme;
  if (typeof r.imageStyle === "string" && r.imageStyle) s.imageStyle = r.imageStyle;
  if (typeof r.includeLinked === "boolean") s.includeLinked = r.includeLinked;
  if (r.saveTo === "note-folder" || r.saveTo === "attachments") s.saveTo = r.saveTo;
  return s;
}
