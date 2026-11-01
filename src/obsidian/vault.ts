import { normalizePath, type App, type TFile } from "obsidian";
import type { VaultFile, VaultReader } from "../material/build";

const toFile = (f: TFile): VaultFile => ({ path: f.path, basename: f.basename, extension: f.extension, size: f.stat.size });

/** A relative path ("../img/a.png") from a folder, as a vault path. */
export function joinRelative(folder: string, relative: string): string {
  const parts = folder ? folder.split("/") : [];
  for (const seg of relative.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

/** The vault as the material builder reads it: links resolved the way
 *  Obsidian resolves them, notes read from its cache. Only the files a
 *  note links to or embeds are ever read. */
export function vaultReader(app: App): VaultReader {
  return {
    resolve(linkpath: string, sourcePath: string): VaultFile | null {
      const lp = linkpath.trim();
      if (!lp) return null;
      const found = app.metadataCache.getFirstLinkpathDest(lp, sourcePath);
      if (found) return toFile(found);
      // Markdown links may be written relative to the note, or from the
      // vault's root with a leading "/".
      const folder = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "";
      const candidates = lp.startsWith("/") ? [lp.slice(1)] : [joinRelative(folder, lp), lp];
      for (const c of candidates) {
        const f = app.vault.getFileByPath(normalizePath(c));
        if (f) return toFile(f);
      }
      return null;
    },
    async read(file: VaultFile): Promise<string> {
      const f = app.vault.getFileByPath(file.path);
      return f ? app.vault.cachedRead(f) : "";
    },
    title(file: VaultFile): string | null {
      const f = app.vault.getFileByPath(file.path);
      const fm = f ? app.metadataCache.getFileCache(f)?.frontmatter : undefined;
      const t: unknown = fm?.title;
      if (typeof t === "string" && t.trim()) return t.trim();
      if (typeof t === "number") return String(t);
      return null;
    },
  };
}
