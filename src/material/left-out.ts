/**
 * What a note holds that is not sent to Synclo, counted so the make window
 * can say so in one line ("Left out: 1 PDF, 1 Dataview query, private
 * comments"). Nothing is left out silently.
 */

export type LeftOutKind =
  | "pdf"
  | "dataview"
  | "search-query"
  | "tasks-query"
  | "bases"
  | "canvas"
  | "audio"
  | "video"
  | "drawing"
  | "other-file"
  | "missing-note"
  | "nested-embed"
  | "gif"
  | "svg"
  | "other-image"
  | "large-image"
  | "missing-image"
  | "inline-image"
  | "image-cap"
  | "linked-cap"
  | "cut-short"
  | "comments";

/** One phrase per kind: [one, many]. "comments" has no count. */
const PHRASES: Record<LeftOutKind, [string, string]> = {
  pdf: ["PDF", "PDFs"],
  dataview: ["Dataview query", "Dataview queries"],
  "search-query": ["search query", "search queries"],
  "tasks-query": ["Tasks query", "Tasks queries"],
  bases: ["Bases view", "Bases views"],
  canvas: ["canvas", "canvases"],
  audio: ["audio file", "audio files"],
  video: ["video", "videos"],
  drawing: ["drawing", "drawings"],
  "other-file": ["attached file", "attached files"],
  "missing-note": ["embed of a missing note", "embeds of missing notes"],
  "nested-embed": ["embed inside an embedded note", "embeds inside embedded notes"],
  gif: ["GIF", "GIFs"],
  svg: ["SVG image", "SVG images"],
  "other-image": ["picture in a format Synclo can't use", "pictures in formats Synclo can't use"],
  "large-image": ["picture over 8 MB", "pictures over 8 MB"],
  "missing-image": ["picture not found in the vault", "pictures not found in the vault"],
  "inline-image": ["picture written into the note as data", "pictures written into the note as data"],
  "image-cap": ["picture past the first 20", "pictures past the first 20"],
  "linked-cap": ["linked note over the limit", "linked notes over the limit"],
  "cut-short": ["note cut short to fit", "notes cut short to fit"],
  comments: ["private comments", "private comments"],
};

/** The order the line reads in: files first, then queries, then limits,
 *  then comments. */
const ORDER: LeftOutKind[] = [
  "pdf",
  "canvas",
  "bases",
  "drawing",
  "audio",
  "video",
  "other-file",
  "gif",
  "svg",
  "other-image",
  "large-image",
  "inline-image",
  "missing-image",
  "image-cap",
  "dataview",
  "search-query",
  "tasks-query",
  "missing-note",
  "nested-embed",
  "linked-cap",
  "cut-short",
  "comments",
];

export class LeftOut {
  private counts = new Map<LeftOutKind, number>();

  add(kind: LeftOutKind, n = 1): void {
    if (n <= 0) return;
    this.counts.set(kind, (this.counts.get(kind) ?? 0) + n);
  }

  get(kind: LeftOutKind): number {
    return this.counts.get(kind) ?? 0;
  }

  isEmpty(): boolean {
    return this.counts.size === 0;
  }

  /** The kinds and counts, in reading order. */
  entries(): Array<[LeftOutKind, number]> {
    return ORDER.filter((k) => this.counts.has(k)).map((k) => [k, this.counts.get(k) ?? 0]);
  }
}

/** "1 PDF, 2 Dataview queries, private comments", or null when nothing is
 *  left out. */
export function describeLeftOut(leftOut: LeftOut): string | null {
  const parts = leftOut.entries().map(([kind, n]) => {
    const [one, many] = PHRASES[kind];
    if (kind === "comments") return one;
    return `${n} ${n === 1 ? one : many}`;
  });
  return parts.length ? parts.join(", ") : null;
}
