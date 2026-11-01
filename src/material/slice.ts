/**
 * The part of a note an embed points at: `![[Note#Heading]]` is that
 * heading's section, `![[Note#H1#H2]]` a section inside a section, and
 * `![[Note#^id]]` the block marked `^id`. Works on the note's body (its
 * frontmatter already removed), skipping anything inside code fences.
 */

interface Heading {
  line: number;
  level: number;
  text: string;
}

const FENCE_OPEN = /^[ \t]*(?:>[ \t]?)*[ \t]*(`{3,}|~{3,})/;

/** Every ATX heading outside code fences. */
export function headingsOf(lines: string[]): Heading[] {
  const out: Heading[] = [];
  let fence: string | null = null;
  lines.forEach((line, i) => {
    const f = FENCE_OPEN.exec(line);
    if (fence) {
      if (f && (f[1] ?? "").startsWith(fence) && /^[ \t]*(?:>[ \t]?)*[ \t]*[`~]+[ \t]*$/.test(line)) fence = null;
      return;
    }
    if (f) {
      fence = f[1] ?? null;
      return;
    }
    const h = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/.exec(line);
    if (h) out.push({ line: i, level: (h[1] ?? "").length, text: h[2] ?? "" });
  });
  return out;
}

/** A heading as a link names it: link and emphasis marks gone, the
 *  characters a link can't hold dropped, case and spacing ignored. */
export function headingKey(text: string): string {
  return text
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#^|[\]:\\*_`=~%]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** The section under a heading: the heading line to the line before the
 *  next heading of its level or higher. */
function sectionAt(lines: string[], headings: Heading[], h: Heading): [number, number] {
  const next = headings.find((o) => o.line > h.line && o.level <= h.level);
  return [h.line, next ? next.line : lines.length];
}

/** The lines `#^id` marks: a list item with its nested lines, a paragraph,
 *  or (for an id on a line of its own) the block just above it. */
function blockAt(lines: string[], id: string): [number, number] | null {
  const tail = new RegExp(`[ \\t]\\^${escapeRegExp(id)}[ \\t]*$`);
  const alone = new RegExp(`^[ \\t]*(?:>[ \\t]?)*\\^${escapeRegExp(id)}[ \\t]*$`);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (alone.test(line)) {
      const start = paragraphStart(lines, i);
      return start < i ? [start, i] : null;
    }
    if (!tail.test(line)) continue;
    const item = /^([ \t]*)(?:[-*+]|\d+[.)])[ \t]/.exec(line);
    if (item) {
      const indent = (item[1] ?? "").length;
      let end = i + 1;
      while (end < lines.length) {
        const next = lines[end] ?? "";
        if (next.trim() === "") break;
        const lead = /^[ \t]*/.exec(next)?.[0].length ?? 0;
        if (lead <= indent) break;
        end++;
      }
      return [i, end];
    }
    return [paragraphStart(lines, i), i + 1];
  }
  return null;
}

/** The first line of the block that ends at line `i`: back to a blank
 *  line or a heading (a heading is a block of its own). */
function paragraphStart(lines: string[], i: number): number {
  let start = i;
  while (start > 0) {
    const prev = lines[start - 1] ?? "";
    if (prev.trim() === "" || /^#{1,6}[ \t]/.test(prev)) break;
    start--;
  }
  return start;
}

/** The text a subpath points at, or null when the note has no such part. */
export function sliceBySubpath(body: string, subpath: string): string | null {
  const parts = subpath
    .split("#")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return body;
  const lines = body.split("\n");
  const last = parts[parts.length - 1] ?? "";
  if (last.startsWith("^")) {
    const range = blockAt(lines, last.slice(1));
    return range ? lines.slice(range[0], range[1]).join("\n") : null;
  }
  const headings = headingsOf(lines);
  let from = 0;
  let to = lines.length;
  for (const part of parts) {
    const key = headingKey(part);
    const h = headings.find((o) => o.line >= from && o.line < to && headingKey(o.text) === key);
    if (!h) return null;
    [from, to] = sectionAt(lines, headings, h);
  }
  return lines.slice(from, to).join("\n");
}

/** Whether the lines end inside an open %% comment (an odd number of %%
 *  marks outside code). */
function opensComment(lines: string[]): boolean {
  let marks = 0;
  let fence = false;
  for (const l of lines) {
    if (/^[ \t]*(`{3,}|~{3,})/.test(l)) fence = !fence;
    if (!fence) marks += (l.match(/%%/g) ?? []).length;
  }
  return marks % 2 === 1;
}

function jsonDrawingText(json: string): string {
  try {
    const data = JSON.parse(json) as { elements?: unknown };
    if (!Array.isArray(data.elements)) return "";
    return data.elements
      .map((el: unknown) => {
        const e = el as { type?: unknown; text?: unknown; isDeleted?: unknown };
        return e.type === "text" && typeof e.text === "string" && e.isDeleted !== true ? e.text.trim() : "";
      })
      .filter(Boolean)
      .join("\n");
  } catch {
    return "";
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The words in an Excalidraw drawing. The Excalidraw plugin keeps a
 * drawing as a note: optional prose, a "Text Elements" section with every
 * label, and the drawing's data (a large compressed block) after it. Only
 * the prose and the labels are words a presentation can use.
 */
export function drawingText(body: string): string {
  // A plain .excalidraw file is the drawing's JSON: its text elements' words.
  if (/^\s*\{/.test(body)) return jsonDrawingText(body);
  const lines = body.split("\n");
  const dataAt = lines.findIndex((l) => /^#{1,2} Excalidraw Data[ \t]*$/.test(l));
  // The prose above the data. The data block is wrapped in a comment that
  // may open just above "# Excalidraw Data": the prose stops where that
  // comment starts. Comments the person wrote in the prose stay whole, so
  // the cleaner leaves them out with everything inside them.
  const above = (dataAt === -1 ? [] : lines.slice(0, dataAt)).filter((l) => !/^==⚠/.test(l));
  while (above.length && (above[above.length - 1] ?? "").trim() === "") above.pop();
  if (above.length && /^%%[ \t]*$/.test(above[above.length - 1] ?? "") && opensComment(above)) above.pop();
  const prose = above.join("\n").trim();
  const from = dataAt === -1 ? 0 : dataAt;
  const textAt = lines.findIndex((l, i) => i >= from && /^#{1,2} Text Elements[ \t]*$/.test(l));
  const labels: string[] = [];
  if (textAt !== -1) {
    for (let i = textAt + 1; i < lines.length; i++) {
      const l = lines[i] ?? "";
      if (/^%%[ \t]*$/.test(l) || /^#{1,2} (Element Links|Embedded Files|Drawing)[ \t]*$/i.test(l) || /^```/.test(l)) break;
      const words = l.replace(/[ \t]\^[A-Za-z0-9_-]{8}[ \t]*$/, "").trimEnd();
      if (words.trim()) labels.push(words);
    }
  }
  return [prose, labels.join("\n")].filter(Boolean).join("\n\n");
}
