import { NetworkError, headerOf, type Http } from "./api/http";
import { SyncloError, MESSAGES } from "./api/errors";

/**
 * Fetching a file Synclo made. Synclo's file link (synclo.app/files/…)
 * answers with a redirect to the file in storage, valid for five minutes.
 * No sign-in is sent: the link itself is the permission, and the token
 * never goes to storage.
 */

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export async function fetchFile(http: Http, url: string, timeoutMs = 180_000): Promise<ArrayBuffer> {
  let at = url;
  for (let hop = 0; hop < 5; hop++) {
    let res;
    try {
      res = await http({ url: at, method: "GET", timeoutMs });
    } catch (err) {
      if (err instanceof NetworkError) throw new SyncloError("network", MESSAGES.network);
      throw err;
    }
    if (REDIRECTS.has(res.status)) {
      const next = headerOf(res, "location");
      if (!next) break;
      const target = new URL(next, at);
      if (target.protocol !== "https:" && target.protocol !== "http:") break;
      at = target.toString();
      continue;
    }
    if (res.status === 200) return res.arrayBuffer();
    if (res.status === 410) throw new SyncloError("rejected", "The download link expired before the file arrived. Try again.", { code: "expired" });
    if (res.status === 404) throw new SyncloError("rejected", "The file is no longer on Synclo. Try again.", { code: "not_found" });
    if (res.status >= 500) throw new SyncloError("unavailable", MESSAGES.unavailable);
    throw new SyncloError("rejected", "The file couldn't be downloaded. Try again.", { code: `http_${res.status}` });
  }
  throw new SyncloError("rejected", "The file couldn't be downloaded. Try again.", { code: "redirect" });
}

/** A file name every system accepts: no path or link characters, not
 *  too long, with the format's extension. */
export function safeFileName(name: string, extension: string, fallback = "Presentation"): string {
  const ext = extension.replace(/^\./, "").toLowerCase();
  // Control characters out first (a file name can't hold them).
  let stem = [...name].filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127).join("").trim();
  if (stem.toLowerCase().endsWith(`.${ext}`)) stem = stem.slice(0, -(ext.length + 1));
  stem = stem
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/\.+$/, "")
    .slice(0, 120)
    .trim();
  return `${stem || fallback}.${ext}`;
}

/** The first of "name.ext", "name 1.ext", "name 2.ext" … that `taken`
 *  doesn't hold. */
export function freePath(folder: string, fileName: string, taken: (path: string) => boolean): string {
  const dot = fileName.lastIndexOf(".");
  const stem = dot === -1 ? fileName : fileName.slice(0, dot);
  const ext = dot === -1 ? "" : fileName.slice(dot);
  const join = (n: string) => (folder ? `${folder}/${n}` : n);
  let path = join(fileName);
  for (let i = 1; taken(path) && i < 1000; i++) path = join(`${stem} ${i}${ext}`);
  return path;
}

/** Words that name no presentation in particular. */
const PLACEHOLDER = /^(untitled|presentation|document|deck)$/i;

/**
 * The name a downloaded file is saved under: the presentation's title (as
 * Synclo names the file), else the first of `fallbacks` (the note's title),
 * made safe for every system.
 */
export function downloadName(exportName: string, extension: string, fallbacks: string[]): string {
  const ext = extension.replace(/^\./, "").toLowerCase();
  let stem = exportName.trim();
  if (stem.toLowerCase().endsWith(`.${ext}`)) stem = stem.slice(0, -(ext.length + 1)).trim();
  const usable = (s: string) => s.trim() !== "" && !PLACEHOLDER.test(s.trim());
  const chosen = usable(stem) ? stem : (fallbacks.find(usable) ?? stem);
  return safeFileName(chosen, ext, "Presentation");
}

/** The list property's new value with `link` in it once: an existing
 *  value (a list, one string, or nothing) is kept as it is. */
export function withFileLink(existing: unknown, link: string): unknown[] {
  const list: unknown[] = Array.isArray(existing) ? [...(existing as unknown[])] : typeof existing === "string" && existing.trim() ? [existing] : [];
  if (!list.some((x) => typeof x === "string" && x.trim() === link)) list.push(link);
  return list;
}
