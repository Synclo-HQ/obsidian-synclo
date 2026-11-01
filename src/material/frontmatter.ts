/**
 * A note's frontmatter: the YAML block between `---` lines at the very top.
 * It is never sent (its fields are the person's own bookkeeping, Dataview
 * fields included); only its `title`, when it has one, names the deck.
 */

export interface SplitNote {
  /** The YAML between the fences, or null when the note has none. */
  frontmatter: string | null;
  /** Everything after the closing fence. */
  body: string;
}

const FENCE = /^---[ \t]*$/;

/** Splits off a leading frontmatter block. A block that is never closed is
 *  not frontmatter (Obsidian reads it as text too). */
export function splitFrontmatter(markdown: string): SplitNote {
  const text = normalizeNewlines(markdown);
  const lines = text.split("\n");
  if (lines.length < 2 || !FENCE.test(lines[0] ?? "")) return { frontmatter: null, body: text };
  for (let i = 1; i < lines.length; i++) {
    if (FENCE.test(lines[i] ?? "")) return { frontmatter: lines.slice(1, i).join("\n"), body: lines.slice(i + 1).join("\n") };
  }
  return { frontmatter: null, body: text };
}

/** A `title:` written on one line in the frontmatter, unquoted. Obsidian's
 *  own parsed frontmatter is preferred when the plugin has it; this is the
 *  fallback for a note the cache hasn't read yet. */
export function frontmatterTitle(frontmatter: string | null): string | null {
  if (!frontmatter) return null;
  for (const line of frontmatter.split("\n")) {
    const m = /^title[ \t]*:[ \t]*(.*)$/i.exec(line);
    if (!m) continue;
    let v = (m[1] ?? "").trim();
    if (!v || v === "|" || v === ">" || v.startsWith("|") || v.startsWith(">")) return null;
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) v = v.slice(1, -1);
    v = v.trim();
    return v || null;
  }
  return null;
}

/** Whether the frontmatter marks the note as an Excalidraw drawing. */
export function isDrawingFrontmatter(frontmatter: string | null): boolean {
  if (!frontmatter) return false;
  return /^["']?excalidraw-plugin["']?[ \t]*:/m.test(frontmatter);
}

export function normalizeNewlines(text: string): string {
  let t = text.replace(/\r\n?/g, "\n");
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  return t;
}
