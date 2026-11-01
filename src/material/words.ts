/**
 * Word counts. Synclo counts words the simple way (runs of non-space), and
 * decides from that count whether a text is source material (20 words or
 * more) or a brief, so the plugin decides with the same count. What the
 * window shows the person counts words as people read them, which also
 * works for languages written without spaces.
 */

/** Synclo's own count: runs of non-space. */
export function serverWordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** Below this, Synclo reads a note as a brief to write from. */
export const SOURCE_MIN_WORDS = 20;

interface WordSegmenter {
  segment(text: string): Iterable<{ isWordLike?: boolean }>;
}

let segmenter: WordSegmenter | null | undefined;

function wordSegmenter(): WordSegmenter | null {
  if (segmenter !== undefined) return segmenter;
  try {
    const ctor = (Intl as unknown as { Segmenter?: new (locale: string | undefined, options: { granularity: "word" }) => WordSegmenter }).Segmenter;
    segmenter = ctor ? new ctor(undefined, { granularity: "word" }) : null;
  } catch {
    segmenter = null;
  }
  return segmenter;
}

/** Words as a reader counts them: picture and link addresses don't count. */
export function readableWordCount(text: string): number {
  const plain = text
    .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, " ")
    .replace(/\]\([^)\n]*\)/g, "] ")
    .replace(/\uE000[EP]\d+\uE001/g, " ")
    .replace(/https?:\/\/\S+/g, " ");
  const seg = wordSegmenter();
  if (!seg) return serverWordCount(plain.replace(/[#>*_`~|[\]-]+/g, " "));
  let n = 0;
  for (const s of seg.segment(plain)) if (s.isWordLike) n++;
  return n;
}
