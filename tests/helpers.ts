import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { NoteInput, VaultFile, VaultReader } from "../src/material/build";

const ROOT = join(__dirname, "fixtures", "vault");
const SIZES: Record<string, number> = JSON.parse(readFileSync(join(__dirname, "fixtures", "vault-sizes.json"), "utf8"));

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));
}

const FILES: VaultFile[] = walk(ROOT).map((abs) => {
  const path = relative(ROOT, abs).split("\\").join("/");
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return { path, basename: dot === -1 ? name : name.slice(0, dot), extension: dot === -1 ? "" : name.slice(dot + 1), size: SIZES[path] ?? statSync(abs).size };
});

/** Resolves links the way Obsidian does for these fixtures: an exact path,
 *  the path with ".md", or the shortest path whose name matches. */
export const fixtureReader: VaultReader = {
  resolve(linkpath: string, sourcePath: string): VaultFile | null {
    const lp = linkpath.trim();
    if (!lp) return null;
    const dir = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "";
    const candidates = [lp, `${lp}.md`, dir ? `${dir}/${lp}` : lp, dir ? `${dir}/${lp}.md` : `${lp}.md`];
    for (const c of candidates) {
      const f = FILES.find((x) => x.path.toLowerCase() === c.toLowerCase());
      if (f) return f;
    }
    const name = lp.split("/").pop()?.toLowerCase() ?? "";
    const byName = FILES.filter((x) => {
      const n = (x.path.split("/").pop() ?? "").toLowerCase();
      return n === name || n === `${name}.md`;
    }).sort((a, b) => a.path.length - b.path.length);
    return byName[0] ?? null;
  },
  async read(file: VaultFile): Promise<string> {
    return readFileSync(join(ROOT, file.path), "utf8");
  },
};

export function fixtureNote(path: string): NoteInput {
  const file = FILES.find((f) => f.path === path);
  if (!file) throw new Error(`No fixture ${path}`);
  return { file, markdown: readFileSync(join(ROOT, path), "utf8") };
}

export function expected(name: string): string {
  return readFileSync(join(__dirname, "fixtures", "expected", name), "utf8").replace(/\n$/, "");
}

/** Picture addresses as Synclo would answer them. */
export function fakeUrls(count: number): Map<number, string> {
  return new Map(Array.from({ length: count }, (_v, i) => [i + 1, `https://img.synclo.test/p${i + 1}.png`]));
}
