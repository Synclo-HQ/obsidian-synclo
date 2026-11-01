/**
 * A markdown link to insert: the selected words as its text when there
 * are any (they stay as written), else the presentation's title. Square
 * brackets in the text are escaped so the link stays one link.
 */
export function markdownLink(selection: string, title: string, url: string): string {
  const words = selection.trim() ? selection : title;
  const text = words.replace(/\\/g, "\\\\").replace(/[[\]]/g, (c) => `\\${c}`);
  return `[${text}](${url})`;
}
