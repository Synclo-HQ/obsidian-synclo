import type { Format, Generation } from "../api/synclo";

/**
 * A presentation being made: kept on this device (Obsidian's local
 * storage for this vault) from the moment Synclo starts it until it is
 * ready, so that closing Obsidian, a phone pausing it, or a restart only
 * delays the link landing in the note.
 */

export interface PendingJob {
  generationId: string;
  /** The note the link is written into when it is ready. */
  notePath: string;
  /** The deck's title as the note names it (until Synclo names it). */
  title: string;
  format: Format;
  /** The server it was made on. */
  base: string;
  startedAt: number;
}

export interface JobStore {
  load(): PendingJob[];
  save(jobs: PendingJob[]): void;
}

export function parseJobs(raw: unknown): PendingJob[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((j: unknown) => {
    if (typeof j !== "object" || j === null) return [];
    const o = j as Record<string, unknown>;
    if (typeof o.generationId !== "string" || typeof o.notePath !== "string" || typeof o.base !== "string" || typeof o.startedAt !== "number") return [];
    return [{ generationId: o.generationId, notePath: o.notePath, title: typeof o.title === "string" ? o.title : "", format: o.format === "document" ? "document" : "slides", base: o.base, startedAt: o.startedAt }];
  });
}

/** "slide" or "section", and their plurals. */
export function unit(format: Format, n: number): string {
  const one = format === "document" ? "section" : "slide";
  return n === 1 ? one : `${one}s`;
}

export interface ProgressText {
  /** The deck's title. */
  title: string;
  /** What is happening now, in a sentence. */
  line: string;
  /** A few words for the status bar. */
  short: string;
}

/** What to tell the person about a generation in progress. */
export function progressText(job: PendingJob, gen: Generation | null): ProgressText {
  const p = gen?.progress ?? null;
  const title = p?.title || gen?.document?.title || job.title || "Untitled";
  if (!gen || gen.status === "queued") return { title, line: "Waiting for Synclo to start…", short: "waiting to start" };
  const total = p?.total ?? 0;
  const written = Math.min(p?.written ?? 0, total);
  if (!p || total === 0) {
    return p?.step === "planning" || !p ? { title, line: `Planning the ${unit(job.format, 2)}…`, short: "planning" } : { title, line: "Starting…", short: "starting" };
  }
  if (written === 0) {
    const names = p.slides.map((s) => s.title).filter(Boolean);
    const shown = names.slice(0, 3).join(", ");
    const more = names.length > 3 ? "…" : "";
    return {
      title,
      line: shown ? `Planned ${total} ${unit(job.format, total)}: ${shown}${more}` : `Planned ${total} ${unit(job.format, total)}`,
      short: `planned ${total} ${unit(job.format, total)}`,
    };
  }
  if (written < total) return { title, line: `${written} of ${total} ${unit(job.format, total)} written`, short: `${written} of ${total} ${unit(job.format, total)}` };
  if (p.pictures && p.pictures.total > 0 && p.pictures.made < p.pictures.total) {
    return { title, line: `Adding pictures: ${p.pictures.made} of ${p.pictures.total}`, short: `pictures ${p.pictures.made} of ${p.pictures.total}` };
  }
  if (p.step === "checking") return { title, line: `Checking every ${unit(job.format, 1)}…`, short: "checking" };
  return { title, line: "Finishing…", short: "finishing" };
}
