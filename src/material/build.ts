import { EMBED_TOKENS, MARK, PICTURE_TOKENS, cleanMarkdown, pictureToken, type CleanResult, type EmbedRef } from "./clean";
import { frontmatterTitle, isDrawingFrontmatter, splitFrontmatter } from "./frontmatter";
import { LeftOut, type LeftOutKind } from "./left-out";
import { altFromFileName, embedAlt, kindOfExtension, kindOfLinkpath, linkDisplay, pictureType, safeAlt } from "./links";
import { drawingText, headingsOf, sliceBySubpath } from "./slice";
import { readableWordCount, serverWordCount } from "./words";

/**
 * A note made into the material sent to Synclo: the note cleaned
 * (clean.ts), its embedded notes and sections inlined one level deep, its
 * own pictures listed for upload, and, when asked, the notes it links to
 * as parts of their own ("## Name", separated by `---`, which Synclo reads
 * as parts). Reads the vault only through a VaultReader, so tests need no
 * Obsidian.
 */

export interface VaultFile {
  path: string;
  basename: string;
  extension: string;
  /** Bytes. */
  size: number;
}

export interface VaultReader {
  /** The file a link reaches from the note at `sourcePath`, or null. */
  resolve(linkpath: string, sourcePath: string): VaultFile | null;
  /** A note's text. */
  read(file: VaultFile): Promise<string>;
  /** The note's title from Obsidian's parsed frontmatter, when it has one. */
  title?(file: VaultFile): string | null;
}

export interface NoteInput {
  file: VaultFile;
  /** The whole note, or the selected text. */
  markdown: string;
  /** The text is a selection, not the whole note. */
  selection?: boolean;
  /** A selection that starts at the note's first character (it may hold
   *  the frontmatter). */
  selectionAtStart?: boolean;
}

export interface BuildOptions {
  includeLinked: boolean;
}

export interface Picture {
  n: number;
  file: VaultFile;
  alt: string;
  type: "image/png" | "image/jpeg" | "image/webp";
}

export interface Placement {
  /** The picture's `n`. */
  picture: number;
  alt: string;
}

export interface Material {
  title: string;
  /** The material, with a placeholder where each picture goes. */
  text: string;
  /** The note's own pictures, once each, in order (what is uploaded). */
  pictures: Picture[];
  /** Each place a picture appears, with the words given there; the text's
   *  picture placeholders number these. */
  placements: Placement[];
  /** Pictures from the web, kept as written. */
  remotePictures: number;
  /** The linked notes included, by name. */
  linkedNotes: string[];
  leftOut: LeftOut;
  /** Words as the window shows them. */
  words: number;
  /** Synclo's count, for the source-or-brief decision. */
  sourceWords: number;
  /** The note is mostly links to other notes. */
  mostlyLinks: boolean;
}

export const LIMITS = {
  maxPictures: 20,
  maxPictureBytes: 8 * 1024 * 1024,
  maxLinkedNotes: 10,
  linkedNoteChars: 20_000,
  linkedTotalChars: 300_000,
  embedChars: 50_000,
  maxInputChars: 400_000,
  maxBodyBytes: 1024 * 1024,
} as const;

const KIND_LEFT_OUT: Partial<Record<ReturnType<typeof kindOfExtension>, LeftOutKind>> = {
  pdf: "pdf",
  audio: "audio",
  video: "video",
  canvas: "canvas",
  bases: "bases",
  other: "other-file",
};

export async function buildMaterial(input: NoteInput, reader: VaultReader, options: BuildOptions): Promise<Material> {
  const leftOut = new LeftOut();
  const pictures: Picture[] = [];
  const placements: Placement[] = [];
  const pictureAt = new Map<string, number>();
  const embeddedWhole = new Set<string>();
  let remotePictures = 0;
  let embedSeq = 0;
  const nextEmbed = () => ++embedSeq;

  const clean = (markdown: string, sourcePath: string): CleanResult => {
    const res = cleanMarkdown(markdown, { sourcePath, leftOut, nextEmbed });
    remotePictures += res.remotePictures;
    return res;
  };

  const picture = (file: VaultFile, alt: string): string => {
    const ext = file.extension.toLowerCase();
    const type = pictureType(ext);
    if (!type) {
      leftOut.add(ext === "gif" ? "gif" : ext === "svg" ? "svg" : "other-image");
      return "";
    }
    if (file.size > LIMITS.maxPictureBytes) {
      leftOut.add("large-image");
      return "";
    }
    let n = pictureAt.get(file.path);
    if (n === undefined) {
      if (pictures.length >= LIMITS.maxPictures) {
        leftOut.add("image-cap");
        return "";
      }
      n = pictures.length + 1;
      pictures.push({ n, file, alt: safeAlt(alt || altFromFileName(file.basename)), type });
      pictureAt.set(file.path, n);
    }
    placements.push({ picture: n, alt: safeAlt(alt || altFromFileName(file.basename)) });
    return pictureToken(placements.length);
  };

  /** A note's body and whether it is a drawing. */
  const bodyOf = (markdown: string, file: VaultFile): { body: string; drawing: boolean; title: string | null } => {
    const split = splitFrontmatter(markdown);
    const drawing = isDrawingFrontmatter(split.frontmatter) || kindOfExtension(file.extension, file.path) === "drawing";
    return { body: drawing ? drawingText(split.body) : split.body, drawing, title: frontmatterTitle(split.frontmatter) };
  };

  const embed = async (e: EmbedRef, depth: number, source: VaultFile): Promise<string> => {
    const file = e.path ? reader.resolve(e.path, e.sourcePath) : source;
    const alt = e.syntax === "wiki" ? embedAlt(e.alias) : e.alias;
    if (!file) {
      const guess = kindOfLinkpath(e.path);
      if (e.syntax === "markdown" || guess === "image") leftOut.add("missing-image");
      else if (guess === "note" || guess === "drawing") leftOut.add("missing-note");
      else leftOut.add(KIND_LEFT_OUT[guess] ?? "other-file");
      return "";
    }
    const kind = kindOfExtension(file.extension, file.path);
    if (kind === "image") return picture(file, alt);
    const dropped = KIND_LEFT_OUT[kind];
    if (dropped) {
      leftOut.add(dropped);
      return "";
    }
    // A note or a drawing.
    if (depth > 0) {
      leftOut.add("nested-embed");
      return e.alias || linkDisplay({ path: e.path, subpath: e.subpath, alias: "" });
    }
    const { body, drawing } = bodyOf(await reader.read(file), file);
    if (drawing && !body.trim()) {
      leftOut.add("drawing");
      return "";
    }
    const slice = e.subpath && !drawing ? sliceBySubpath(body, e.subpath) : body;
    if (slice === null) {
      leftOut.add("missing-note");
      return "";
    }
    if (!e.subpath) embeddedWhole.add(file.path);
    let text = await expand(clean(slice, file.path), depth + 1, file);
    if (text.length > LIMITS.embedChars) {
      text = cutAt(text, LIMITS.embedChars);
      leftOut.add("cut-short");
    }
    return text;
  };

  const expand = async (res: CleanResult, depth: number, source: VaultFile): Promise<string> => {
    const made = new Map<number, string>();
    for (const e of res.embeds) made.set(e.n, await embed(e, depth, source));
    return placeEmbeds(res.text, made);
  };

  // The note itself.
  let markdown = input.markdown;
  let fmTitle: string | null = null;
  let drawing = kindOfExtension(input.file.extension, input.file.path) === "drawing";
  if (!input.selection || input.selectionAtStart) {
    const own = bodyOf(markdown, input.file);
    markdown = own.body;
    drawing = drawing || own.drawing;
    if (!input.selection) fmTitle = own.title;
  } else if (drawing) {
    markdown = drawingText(markdown);
  }
  if (input.selection && !reader.title) fmTitle = bodyOf(await reader.read(input.file), input.file).title;
  const title = (reader.title?.(input.file) ?? fmTitle ?? "").trim() || input.file.basename.replace(/\.excalidraw$/i, "");
  const main = clean(markdown, input.file.path);
  let mainText = await expand(main, 0, input.file);

  // The notes it links to, one level deep.
  const linkedNotes: string[] = [];
  const linkedParts: string[] = [];
  if (options.includeLinked && !drawing) {
    const seen = new Set<string>([input.file.path, ...embeddedWhole]);
    const targets: VaultFile[] = [];
    for (const link of main.links) {
      const file = reader.resolve(link, input.file.path);
      if (!file || seen.has(file.path)) continue;
      const kind = kindOfExtension(file.extension, file.path);
      if (kind !== "note" && kind !== "drawing") continue;
      seen.add(file.path);
      targets.push(file);
    }
    let total = 0;
    for (const [i, file] of targets.entries()) {
      if (i >= LIMITS.maxLinkedNotes || total >= LIMITS.linkedTotalChars) {
        leftOut.add("linked-cap", targets.length - i);
        break;
      }
      const own = bodyOf(await reader.read(file), file);
      let body = await expand(clean(own.body, file.path), 1, file);
      if (!body.trim()) continue;
      if (body.length > LIMITS.linkedNoteChars) {
        body = cutAt(body, LIMITS.linkedNoteChars);
        leftOut.add("cut-short");
      }
      const name = (reader.title?.(file) ?? own.title ?? "").trim() || file.basename.replace(/\.excalidraw$/i, "");
      body = withoutRepeatedTitle(body, [name, file.basename]);
      const part = body.trim() ? `## ${name}\n\n${demoteHeadings(body, 3)}` : `## ${name}`;
      if (total + part.length > LIMITS.linkedTotalChars) {
        leftOut.add("linked-cap", targets.length - i);
        break;
      }
      total += part.length;
      linkedParts.push(part);
      linkedNotes.push(name);
    }
  }

  mainText = mainText.trim();
  if (!/^#[ \t]/.test(mainText)) mainText = mainText ? `# ${title}\n\n${mainText}` : `# ${title}`;
  const text = tidy([mainText, ...linkedParts].join("\n\n---\n\n"));
  const withoutPictures = text.replace(PICTURE_TOKENS, " ");
  const mainWords = serverWordCount(mainText.replace(PICTURE_TOKENS, " "));
  const uniqueLinks = new Set(main.links).size;
  return {
    title,
    text,
    pictures,
    placements,
    remotePictures,
    linkedNotes,
    leftOut,
    words: readableWordCount(withoutPictures),
    sourceWords: serverWordCount(withoutPictures),
    mostlyLinks: !options.includeLinked && uniqueLinks >= 2 && mainWords - main.linkWords < 20,
  };
}

/**
 * Puts each embed's text where its placeholder was. An embed on a line of
 * its own becomes a block (kept inside the quote or list item it sat in);
 * one inside a sentence is read inline.
 */
export function placeEmbeds(text: string, made: Map<number, string>): string {
  if (!made.size) return text;
  const out: string[] = [];
  /** The level of the heading the embed sits under (0 for none). */
  let under = 0;
  let fence = false;
  for (const line of text.split("\n")) {
    if (/^[ \t]*(?:>[ \t]?)*[ \t]*(`{3,}|~{3,})/.test(line)) fence = !fence;
    const heading = fence ? null : /^(#{1,6})[ \t]/.exec(line);
    if (heading) under = (heading[1] ?? "").length;
    if (!line.includes(`${MARK}E`)) {
      out.push(line);
      continue;
    }
    const whole = /^((?:[ \t]{0,3}>[ \t]?)*)([ \t]*(?:[-*+][ \t]+|\d+[.)][ \t]+)?)\uE000E(\d+)\uE001[ \t]*$/.exec(line);
    if (whole) {
      const quote = whole[1] ?? "";
      const lead = whole[2] ?? "";
      let content = (made.get(Number(whole[3])) ?? "").trim();
      if (!content) {
        if (quote) out.push(quote.trimEnd());
        continue;
      }
      // An embedded note's headings sit under the heading it is embedded
      // beneath, as its sections do in the note.
      content = demoteHeadings(content, Math.min(6, under + 1));
      const lines = content.split("\n");
      if (!quote && !lead.trim()) {
        if (lines.length === 1) out.push(lines[0] ?? "");
        else out.push("", ...lines, "");
        continue;
      }
      const cont = quote + " ".repeat(lead.length);
      out.push(quote + lead + (lines[0] ?? ""), ...lines.slice(1).map((l) => (l.trim() ? cont + l : quote.trimEnd())));
      continue;
    }
    out.push(line.replace(EMBED_TOKENS, (_m, n: string) => (made.get(Number(n)) ?? "").replace(/\s*\n\s*/g, " ").trim()));
  }
  return out.join("\n");
}

/** The material as sent: each picture where it was, at its Synclo address
 *  (or left out when it couldn't be sent). */
export function withPictures(material: Pick<Material, "text" | "placements">, urls: Map<number, string>): string {
  const text = material.text.replace(PICTURE_TOKENS, (_m, k: string) => {
    const place = material.placements[Number(k) - 1];
    const url = place ? urls.get(place.picture) : undefined;
    if (!place || !url) return "";
    return `![${place.alt}](${url.replace(/[ ()]/g, (c) => encodeURIComponent(c))})`;
  });
  return tidy(dropHollowLines(text));
}

/** The material as the window previews it: a picture reads as its words
 *  or its file name. */
export function previewText(material: Pick<Material, "text" | "placements" | "pictures">): string {
  const byN = new Map(material.pictures.map((p) => [p.n, p]));
  return material.text.replace(PICTURE_TOKENS, (_m, k: string) => {
    const place = material.placements[Number(k) - 1];
    const pic = place ? byN.get(place.picture) : undefined;
    return place && pic ? `[Picture: ${place.alt || pic.file.basename}]` : "";
  });
}

/** Headings moved down so the shallowest is `level` (a linked note's own
 *  headings sit under its "## Name"). Code fences are left alone. */
export function demoteHeadings(text: string, level: number): string {
  const lines = text.split("\n");
  const headings = headingsOf(lines);
  if (!headings.length) return text;
  const shallowest = Math.min(...headings.map((h) => h.level));
  const by = Math.max(0, level - shallowest);
  if (!by) return text;
  for (const h of headings) {
    const line = lines[h.line] ?? "";
    lines[h.line] = line.replace(/^#{1,6}/, "#".repeat(Math.min(6, h.level + by)));
  }
  return lines.join("\n");
}

/** A note's first line dropped when it is a heading that only repeats
 *  the note's name (it is about to be written as the part's own heading). */
function withoutRepeatedTitle(body: string, names: string[]): string {
  const m = /^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*(?:\n|$)/.exec(body.trimStart());
  if (!m) return body;
  const key = (s: string) => s.replace(/[*_`]/g, "").trim().toLowerCase();
  if (!names.some((n) => key(n) === key(m[1] ?? ""))) return body;
  return body.trimStart().slice(m[0].length).trimStart();
}

/** Text cut to about `max` characters at a paragraph or line end. */
export function cutAt(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const para = head.lastIndexOf("\n\n");
  const line = head.lastIndexOf("\n");
  const at = para > max * 0.6 ? para : line > max * 0.6 ? line : max;
  return `${head.slice(0, at).trimEnd()}\n\n…`;
}

/** Drops list items left empty where a picture couldn't be sent. */
function dropHollowLines(text: string): string {
  return text
    .split("\n")
    .filter((l) => !/^[ \t]*(?:>[ \t]?)*[ \t]*(?:[-*+]|\d+[.)])[ \t]*$/.test(l))
    .join("\n");
}

/** One blank line between blocks at most, none at the ends. */
function tidy(text: string): string {
  return text.replace(/[ \t]+\n/g, (s) => (s.length >= 3 ? s : "\n")).replace(/\n{3,}/g, "\n\n").trim();
}
