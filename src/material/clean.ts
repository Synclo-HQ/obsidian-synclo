import { LeftOut } from "./left-out";
import { isExternal, linkDisplay, parseMarkdownTarget, parseWikiInner } from "./links";

/**
 * One note's markdown made into material Synclo reads, line by line, with
 * the states Obsidian itself honours: code fences (kept as written, never
 * searched for comments or tags), math blocks, `%%comments%%` and
 * `<!-- comments -->` (never sent, inline or across lines), and inline
 * code spans. Nothing here reads the vault: an embed or a local picture
 * becomes a placeholder (see MARK below) that build.ts resolves.
 *
 * What changes, and why:
 * - wikilinks read as their alias or note name ("Plan › Budget");
 * - inline #tags and ^block-ids go (they are the vault's bookkeeping);
 * - callouts become a quote with a bold title; ==highlights== become bold;
 * - Dataview, search, Tasks and Bases blocks are left out (they are
 *   queries, not words) and counted in the "Left out" line;
 * - Dataview fields read as "key: value";
 * - a heading underlined with `---` becomes `## heading` and a rule is
 *   written `---`, because Synclo starts a new part at a `---` line.
 * Everything else (lists, tasks, tables, footnotes, math, Mermaid source,
 * external links and web pictures) is kept as written.
 */

export interface EmbedRef {
  n: number;
  /** The link's path, as written. */
  path: string;
  subpath: string;
  alias: string;
  /** `![[…]]` or `![…](…)`. */
  syntax: "wiki" | "markdown";
  /** The note it was written in (links resolve from there). */
  sourcePath: string;
}

export interface CleanResult {
  text: string;
  embeds: EmbedRef[];
  /** Notes the text links to (wikilinks and markdown links), in order. */
  links: string[];
  /** Pictures from the web, kept as written. */
  remotePictures: number;
  /** Words that were link names (for the "mostly links" hint). */
  linkWords: number;
}

export interface CleanOptions {
  sourcePath: string;
  leftOut: LeftOut;
  /** Numbers embeds across every note cleaned for one material. */
  nextEmbed: () => number;
}

/** Placeholders for what the vault fills in later: an embed (E) or a
 *  picture (P). Written with private-use characters, which notes don't
 *  hold. */
export const MARK = "\uE000";
export const MARK_END = "\uE001";
export const embedToken = (n: number): string => `${MARK}E${n}${MARK_END}`;
export const pictureToken = (n: number): string => `${MARK}P${n}${MARK_END}`;
export const EMBED_TOKENS = /\uE000E(\d+)\uE001/g;
export const PICTURE_TOKENS = /\uE000P(\d+)\uE001/g;
/** Marks a chunk that doesn't start a line, so a tag needs a space before it. */
const NOT_LINE_START = "\uE002";

type Mode = "normal" | "comment" | "html";

interface Fence {
  char: "`" | "~";
  length: number;
  /** Left out (a query); its lines are not kept. */
  drop: boolean;
  /** An Admonition block (```ad-note), kept as a quote. */
  admonition: boolean;
  /** The quote markers the fence opened under. */
  depth: number;
}

const DROPPED: Record<string, "dataview" | "search-query" | "tasks-query" | "bases"> = {
  dataview: "dataview",
  dataviewjs: "dataview",
  query: "search-query",
  tasks: "tasks-query",
  base: "bases",
};

/** `>` markers at the start of a line, and what follows them. */
function splitQuote(line: string): { prefix: string; depth: number; rest: string } {
  const m = /^((?:[ \t]{0,3}>[ \t]?)+)/.exec(line);
  if (!m) return { prefix: "", depth: 0, rest: line };
  const prefix = m[1] ?? "";
  return { prefix, depth: (prefix.match(/>/g) ?? []).length, rest: line.slice(prefix.length) };
}

/** A line with `depth` quote markers taken off (for lines inside a fence
 *  that opened in a quote). */
function dropQuote(line: string, depth: number): string {
  let rest = line;
  for (let i = 0; i < depth; i++) {
    const m = /^[ \t]{0,3}>[ \t]?/.exec(rest);
    if (!m) break;
    rest = rest.slice(m[0].length);
  }
  return rest;
}

function openFence(rest: string): { char: "`" | "~"; length: number; info: string } | null {
  const m = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(rest);
  if (!m) return null;
  const run = m[1] ?? "";
  const info = (m[2] ?? "").trim();
  if (run[0] === "`" && info.includes("`")) return null;
  return { char: run[0] === "~" ? "~" : "`", length: run.length, info };
}

function closesFence(rest: string, fence: Fence): boolean {
  const m = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(rest);
  return !!m && (m[1] ?? "")[0] === fence.char && (m[1] ?? "").length >= fence.length;
}

function calloutLabel(type: string): string {
  const words = type.replace(/[-_]+/g, " ").trim();
  return words ? words[0]?.toUpperCase() + words.slice(1) : "Note";
}

/** A line that can carry a setext underline: plain paragraph text. */
function isParagraph(line: string | undefined): boolean {
  if (line === undefined) return false;
  const t = line.trim();
  if (!t) return false;
  if (/^(#{1,6}[ \t]|[-*+][ \t]|\d+[.)][ \t]|\||>|<|`{3}|~{3}|\$\$)/.test(t)) return false;
  return true;
}

const TAG = /(^|\s)#([\p{L}\p{N}\p{M}_/-]+)/gu;
const WIKI = /(!?)\[\[([^[\]\n]+?)\]\]/g;
const MD_LINK = /(!?)\[((?:[^[\]\n]|\[[^[\]\n]*\])*)\]\(\s*(<[^>\n]*>|(?:[^\s()]|\([^\s()]*\))+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)/g;
const FIELD_BRACKET = /\[([\p{L}\p{N}][\p{L}\p{N} _/-]{0,60}?)::[ \t]*([^\]\n]*)\]/gu;
const FIELD_PAREN = /\(([\p{L}\p{N}][\p{L}\p{N} _/-]{0,60}?)::[ \t]*([^)\n]*)\)/gu;
/** A line that is one bracketed field, after any list marker or task box. */
const FIELD_WHOLE = /^([ \t]*(?:[-*+][ \t]+(?:\[.\][ \t]+)?|\d+[.)][ \t]+)?)(?:\[([\p{L}\p{N}][\p{L}\p{N} _/-]{0,60}?)::[ \t]*([^\]\n]*)\]|\(([\p{L}\p{N}][\p{L}\p{N} _/-]{0,60}?)::[ \t]*([^)\n]*)\))[ \t]*$/u;
/** Where a field inside a sentence was taken out (tidied before sending). */
const FIELD_GONE = "\uE003";
const FIELD_LINE = /^([ \t]*(?:>[ \t]?)*[ \t]*(?:[-*+][ \t]+(?:\[.\][ \t]+)?|\d+[.)][ \t]+)?)([\p{L}\p{N}][\p{L}\p{N} _/-]{0,60}?)::(?=[ \t]|$)/u;
const HIGHLIGHT = /==(\S(?:[^\n]*?\S)?)==/g;
const BLOCK_ID_TAIL = /[ \t]+\^[A-Za-z0-9-]+[ \t]*$/;
const BLOCK_ID_ALONE = /^[ \t]*(?:>[ \t]?)*[ \t]*\^[A-Za-z0-9-]+[ \t]*$/;

export function cleanMarkdown(markdown: string, options: CleanOptions): CleanResult {
  const { leftOut, sourcePath } = options;
  const embeds: EmbedRef[] = [];
  const links: string[] = [];
  let remotePictures = 0;
  let linkWords = 0;
  let sawComment = false;

  const out: string[] = [];
  const push = (line: string) => {
    const last = out[out.length - 1];
    if (line.trim() === "" && (last === undefined || last.trim() === "")) return;
    // A quote's empty line once, never twice in a row.
    if (/^[ \t]*(?:>[ \t]?)+$/.test(line) && last !== undefined && last.trim() === line.trim()) return;
    out.push(line);
  };
  /** A line that held something and now holds nothing (a comment, a
   *  query): keeps the quote it sat in, else ends the paragraph. */
  const pushRemoved = (prefix: string) => push(prefix ? prefix.trimEnd() : "");

  const prose = (text: string): string => {
    let t = text;
    // A Dataview field inside a sentence is the vault's bookkeeping, not
    // the sentence's words: it goes, before the link pass reads brackets.
    // (A field that is a whole line was written out as words already.)
    const fields = t.replace(FIELD_BRACKET, FIELD_GONE).replace(FIELD_PAREN, FIELD_GONE);
    if (fields !== t) removedInLine = true;
    t = fields;
    t = t.replace(WIKI, (_m, bang: string, inner: string) => {
      const parts = parseWikiInner(inner);
      if (bang) {
        const n = options.nextEmbed();
        embeds.push({ n, path: parts.path, subpath: parts.subpath, alias: parts.alias, syntax: "wiki", sourcePath });
        return embedToken(n);
      }
      if (parts.path) links.push(parts.path);
      const shown = linkDisplay(parts);
      linkWords += shown.split(/\s+/).filter(Boolean).length;
      return shown;
    });
    t = t.replace(MD_LINK, (whole, bang: string, label: string, rawTarget: string) => {
      const target = rawTarget.trim();
      const bare = target.startsWith("<") && target.endsWith(">") ? target.slice(1, -1).trim() : target;
      if (bang) {
        if (/^data:/i.test(bare)) {
          leftOut.add("inline-image");
          return "";
        }
        if (/^https?:\/\//i.test(bare)) {
          remotePictures++;
          return `![${label.replace(/[[\]]/g, "")}](${bare.replace(/ /g, "%20")})`;
        }
        if (isExternal(bare)) return "";
        const { path, subpath } = parseMarkdownTarget(target);
        const n = options.nextEmbed();
        embeds.push({ n, path, subpath, alias: label, syntax: "markdown", sourcePath });
        return embedToken(n);
      }
      if (/^obsidian:/i.test(bare)) return label;
      if (isExternal(bare) || bare.startsWith("#")) return bare.startsWith("#") ? label : whole;
      const { path } = parseMarkdownTarget(target);
      if (path) links.push(path);
      return label;
    });
    t = t.replace(HIGHLIGHT, (_m, inner: string) => `**${inner}**`);
    let removedTag = false;
    t = t.replace(TAG, (m, lead: string, name: string) => {
      if (/^\p{N}+$/u.test(name)) return m;
      removedTag = true;
      return lead;
    });
    if (removedTag) {
      t = t.replace(/(\S)[ \t]{2,}(?=\S)/g, "$1 ");
      removedInLine = true;
    }
    return closeGaps(t);
  };
  /** Something was taken out of the current line (a comment, a tag). */
  let removedInLine = false;

  /** Scans one line for code spans and comments; prose between them is
   *  transformed. Returns the line as sent and the mode the next line
   *  starts in. */
  const scan = (line: string, start: Mode): { text: string; mode: Mode } => {
    let mode = start;
    let i = 0;
    let text = "";
    let chunk = "";
    let chunkStartsLine = true;
    const flush = () => {
      if (!chunk) return;
      if (chunkStartsLine) text += prose(chunk);
      else {
        const before = text.slice(-1);
        const marked = /\s/.test(before) ? chunk : `${NOT_LINE_START}${chunk}`;
        text += prose(marked).replace(NOT_LINE_START, "");
      }
      chunk = "";
    };
    while (i < line.length) {
      if (mode === "comment" || mode === "html") {
        const close = mode === "comment" ? "%%" : "-->";
        const end = line.indexOf(close, i);
        sawComment = true;
        removedInLine = true;
        if (end === -1) return { text, mode };
        i = skipJoin(line, end + close.length, text);
        mode = "normal";
        chunkStartsLine = false;
        continue;
      }
      const ch = line[i];
      if (ch === "`") {
        let run = 1;
        while (line[i + run] === "`") run++;
        const close = findRun(line, i + run, run);
        if (close === -1) {
          chunk += line.slice(i, i + run);
          i += run;
          continue;
        }
        flush();
        const span = line.slice(i, close + run);
        const inner = line.slice(i + run, close).trim();
        if (inner.startsWith("=") || inner.startsWith("$=")) {
          leftOut.add("dataview");
          removedInLine = true;
          i = skipJoin(line, close + run, text);
        } else {
          text += span;
          i = close + run;
        }
        chunkStartsLine = false;
        continue;
      }
      if (ch === "%" && line[i + 1] === "%") {
        flush();
        mode = "comment";
        sawComment = true;
        i += 2;
        continue;
      }
      if (ch === "<" && line.startsWith("<!--", i)) {
        flush();
        mode = "html";
        sawComment = true;
        i += 4;
        continue;
      }
      chunk += ch;
      i++;
    }
    flush();
    return { text, mode };
  };

  const lines = markdown.split("\n");
  let mode: Mode = "normal";
  let fence: Fence | null = null;
  let math = false;
  /** An open Admonition block: its lines are kept as a quote. */
  let admonition: Fence | null = null;
  /** Its option lines (title:, collapse:) come first and are read, not kept. */
  let admonitionOptions = false;

  for (const raw of lines) {
    // Inside a code fence: kept as written, or left out whole.
    if (fence) {
      const inner = dropQuote(raw, fence.depth);
      if (closesFence(inner, fence)) {
        if (!fence.drop) push(admonition ? `> ${raw}` : raw);
        fence = null;
      } else if (!fence.drop) push(admonition ? `> ${raw}` : raw);
      continue;
    }
    if (math) {
      push(raw);
      if (raw.trim().endsWith("$$")) math = false;
      continue;
    }

    let line = raw;
    if (mode === "normal") {
      const { prefix, depth, rest } = splitQuote(raw);
      // The end of an Admonition block.
      if (admonition && closesFence(rest, admonition)) {
        admonition = null;
        push("");
        continue;
      }
      const opened = openFence(rest);
      if (opened) {
        const lang = (opened.info.split(/\s+/)[0] ?? "").toLowerCase();
        const dropped = DROPPED[lang];
        if (dropped) {
          leftOut.add(dropped);
          fence = { char: opened.char, length: opened.length, drop: true, admonition: false, depth };
          pushRemoved(prefix);
          continue;
        }
        if (lang.startsWith("ad-") && !admonition) {
          admonition = { char: opened.char, length: opened.length, drop: false, admonition: true, depth };
          const title = admonitionTitle(lang.slice(3));
          push("");
          push(`> **${title}**`);
          admonitionOptions = true;
          continue;
        }
        fence = { char: opened.char, length: opened.length, drop: false, admonition: false, depth };
        push(admonition ? `> ${raw}` : raw);
        continue;
      }
      if (rest.trim().startsWith("$$")) {
        const t = rest.trim();
        push(admonition ? `> ${raw}` : raw);
        if (!(t.length > 2 && t.endsWith("$$") && t !== "$$")) math = true;
        continue;
      }
      // Admonition options (title:, collapse:, icon:, color:) at its start.
      if (admonition && admonitionOptions) {
        const opt = /^[ \t]*(title|collapse|icon|color)[ \t]*:[ \t]*(.*)$/i.exec(rest);
        if (opt) {
          if ((opt[1] ?? "").toLowerCase() === "title" && (opt[2] ?? "").trim()) {
            out[out.length - 1] = `> **${(opt[2] ?? "").trim()}**`;
          }
          continue;
        }
        admonitionOptions = false;
      }
      // A heading underlined with === or ---.
      if (!prefix && !admonition && /^[ \t]{0,3}(={2,}|-{2,})[ \t]*$/.test(rest) && isParagraph(out[out.length - 1])) {
        const level = rest.trim().startsWith("=") ? "#" : "##";
        out[out.length - 1] = `${level} ${(out[out.length - 1] ?? "").trim()}`;
        continue;
      }
      // A rule, written the way Synclo splits parts.
      if (/^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(rest)) {
        if (prefix || admonition) push(admonition ? "> ---" : `${prefix}---`);
        else {
          push("");
          push("---");
          push("");
        }
        continue;
      }
      // A line that is one Dataview field reads as "key: value".
      const field = FIELD_WHOLE.exec(rest);
      if (field) line = `${prefix}${field[1] ?? ""}${(field[2] ?? field[4] ?? "").trim()}: ${(field[3] ?? field[5] ?? "").trim()}`;
      // A callout's first line: its title, in bold.
      const callout = /^\[!([^\]\s]+)\]([+-]?)[ \t]*(.*)$/.exec(rest);
      if (prefix && callout) line = `${prefix}**${(callout[3] ?? "").trim() || calloutLabel(callout[1] ?? "")}**`;
      if (BLOCK_ID_ALONE.test(line)) continue;
    }

    const startedIn = mode;
    removedInLine = false;
    const scanned = scan(line, mode);
    mode = scanned.mode;
    // A line wholly inside a comment leaves no trace, not even a break.
    if (startedIn !== "normal" && mode !== "normal") continue;
    let text = scanned.text;
    if (BLOCK_ID_TAIL.test(text)) text = text.replace(BLOCK_ID_TAIL, "");
    if (removedInLine) text = text.replace(/[ \t]+$/, "");
    text = text.replace(FIELD_LINE, (_m, lead: string, key: string) => `${lead}${key.trim()}:`);
    const { prefix } = splitQuote(line);
    const emptied = raw.trim() !== "" && isHollow(text);
    if (emptied || (startedIn !== "normal" && text.trim() === "")) {
      if (raw.trim() !== "") pushRemoved(prefix);
      continue;
    }
    push(admonition ? `> ${text}` : text);
  }
  if (sawComment) leftOut.add("comments");

  while (out.length && (out[out.length - 1] ?? "").trim() === "") out.pop();
  return { text: out.join("\n"), embeds, links, remotePictures, linkWords };
}

function admonitionTitle(type: string): string {
  return calloutLabel(type);
}

/** Closes the gap a field left inside a sentence: one space between
 *  words, none before punctuation or a closing bracket, none at the start. */
function closeGaps(text: string): string {
  if (!text.includes(FIELD_GONE)) return text;
  return text.replace(/[ \t]*(?:\uE003[ \t]*)+/g, (gap: string, at: number, whole: string) => {
    const before = whole.slice(0, at);
    const next = whole[at + gap.length];
    if (next === undefined || /[.,;:!?)\]}…]/.test(next)) return "";
    if (/[([{]$/.test(before)) return "";
    if (before === "") return /^[ \t]/.test(gap) ? " " : "";
    return /[ \t]/.test(gap) ? " " : "";
  });
}

/** A line with nothing left but quote markers, a list marker or a task box. */
function isHollow(text: string): boolean {
  return /^[ \t]*(?:>[ \t]?)*[ \t]*(?:[-*+]|\d+[.)])?[ \t]*(?:\[.\])?[ \t]*$/.test(text);
}

/** Where text resumes after something taken out: past the spaces that
 *  follow it when the text before already ends in a space (or is empty),
 *  so "a %%x%% b" reads "a b". */
function skipJoin(line: string, from: number, before: string): number {
  let i = from;
  if (before === "" || /[ \t]$/.test(before)) while (line[i] === " " || line[i] === "\t") i++;
  return i;
}

/** Where a run of exactly `n` backticks starts at or after `from`, or -1. */
function findRun(line: string, from: number, n: number): number {
  let i = from;
  while (i < line.length) {
    if (line[i] !== "`") {
      i++;
      continue;
    }
    let run = 1;
    while (line[i + run] === "`") run++;
    if (run === n) return i;
    i += run;
  }
  return -1;
}
