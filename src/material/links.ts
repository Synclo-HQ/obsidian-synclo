/**
 * Links and embeds as Obsidian writes them: `[[path#sub|alias]]`,
 * `![[path#sub|alias]]`, `[text](path)` and `![alt](path)`. Pure string
 * work; which file a link reaches is the vault reader's job (build.ts).
 */

export interface LinkParts {
  /** The path or note name, without the subpath ("" for the same note). */
  path: string;
  /** "#Heading", "#H1#H2", "#^block", or "". */
  subpath: string;
  /** The words after the first `|`, or "". */
  alias: string;
}

/** The inside of `[[…]]`. A `\|` (written inside tables) separates the
 *  alias too. */
export function parseWikiInner(inner: string): LinkParts {
  const unescaped = inner.replace(/\\\|/g, "|");
  const bar = unescaped.indexOf("|");
  const target = (bar === -1 ? unescaped : unescaped.slice(0, bar)).trim();
  const alias = bar === -1 ? "" : unescaped.slice(bar + 1).trim();
  const hash = target.indexOf("#");
  return {
    path: (hash === -1 ? target : target.slice(0, hash)).trim(),
    subpath: hash === -1 ? "" : target.slice(hash).trim(),
    alias,
  };
}

/** A markdown link's address as a vault path: angle brackets and percent
 *  escapes undone, the subpath split off. */
export function parseMarkdownTarget(raw: string): { path: string; subpath: string } {
  let t = raw.trim();
  if (t.startsWith("<") && t.endsWith(">")) t = t.slice(1, -1);
  let decoded = t;
  try {
    decoded = decodeURI(t);
  } catch {
    decoded = t;
  }
  const hash = decoded.indexOf("#");
  return { path: hash === -1 ? decoded : decoded.slice(0, hash), subpath: hash === -1 ? "" : decoded.slice(hash) };
}

/** Whether a markdown link points outside the vault (a web page, mail). */
export function isExternal(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(target.trim().replace(/^</, ""));
}

/** The last path segment, without a `.md` extension. */
export function noteName(path: string): string {
  const seg = path.split("/").pop() ?? path;
  return seg.replace(/\.md$/i, "");
}

/** How a link reads in the material: its alias, else the note's name, with
 *  the heading it points at ("Plan › Budget"). */
export function linkDisplay(parts: LinkParts): string {
  if (parts.alias) return parts.alias;
  const headings = parts.subpath
    .split("#")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("^"));
  const name = noteName(parts.path);
  if (!name) return headings.join(" › ");
  return headings.length ? `${name} › ${headings.join(" › ")}` : name;
}

export type FileKind = "note" | "drawing" | "image" | "pdf" | "audio" | "video" | "canvas" | "bases" | "other";

const IMAGE = new Set(["png", "jpg", "jpeg", "webp", "gif", "svg", "bmp", "avif", "heic", "heif", "tif", "tiff", "ico"]);
const AUDIO = new Set(["mp3", "wav", "m4a", "ogg", "3gp", "flac", "aac", "opus", "weba"]);
const VIDEO = new Set(["mp4", "webm", "ogv", "mov", "mkv", "m4v", "avi"]);

/** What kind of file an extension names. */
export function kindOfExtension(extension: string, name = ""): FileKind {
  const ext = extension.toLowerCase();
  if (ext === "md") return /\.excalidraw$/i.test(name.replace(/\.md$/i, "")) ? "drawing" : "note";
  if (ext === "excalidraw") return "drawing";
  if (IMAGE.has(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (AUDIO.has(ext)) return "audio";
  if (VIDEO.has(ext)) return "video";
  if (ext === "canvas") return "canvas";
  if (ext === "base") return "bases";
  return "other";
}

/** The kind a link's own text suggests, for a link that reaches no file:
 *  a known extension names its kind, anything else reads as a note. */
export function kindOfLinkpath(path: string): FileKind {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(path);
  if (!m) return "note";
  const kind = kindOfExtension(m[1] ?? "", path);
  return kind === "other" ? "note" : kind;
}

/** The upload type for a picture Synclo accepts, else null. */
export function pictureType(extension: string): "image/png" | "image/jpeg" | "image/webp" | null {
  const ext = extension.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  return null;
}

/** An embed's `|…` parts: Obsidian reads `300` or `300x200` as a size;
 *  the first other part is the picture's words. */
export function embedAlt(alias: string): string {
  for (const part of alias.split("|")) {
    const p = part.trim();
    if (p && !/^\d+(x\d+)?$/i.test(p)) return p;
  }
  return "";
}

/** Words for a picture that came with none: its file name, unless the name
 *  is a camera's or a paste's ("IMG_2041", "Pasted image 2024…"). */
export function altFromFileName(basename: string): string {
  const b = basename.trim();
  if (!b) return "";
  if (/^(img|dsc|dscn|dcim|pxl|mvimg|screenshot|screen shot|pasted image|image|photo|cleanshot|wp)[\s_-]*[\d\s_.:-]*$/i.test(b)) return "";
  if (/^[\d\s_.:-]+$/.test(b)) return "";
  if (/^(pasted image|screenshot|screen shot|cleanshot)\b/i.test(b)) return "";
  return b.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Picture words as Synclo reads them: no brackets or line breaks. */
export function safeAlt(alt: string): string {
  return alt.replace(/[[\]\n\r]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}
