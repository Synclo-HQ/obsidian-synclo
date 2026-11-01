import type { Format, Generation, Status } from "../api/synclo";

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
  /** The workspace it was made in (jobs saved before this was kept have
   *  none, and are followed in whatever workspace is connected). */
  workspace?: WorkspaceRef;
  startedAt: number;
}

/** A workspace as Synclo names it: its id when Synclo gives one, and its
 *  name. */
export interface WorkspaceRef {
  id?: string;
  name: string;
}

/** Whether a job belongs to the connected workspace. A job that names no
 *  workspace belongs to any; with no workspace known yet, none that names
 *  one does. Ids are compared when both sides have one, else names. */
export function sameWorkspace(job: PendingJob, current: WorkspaceRef | null): boolean {
  if (!job.workspace) return true;
  if (!current) return false;
  if (job.workspace.id && current.id) return job.workspace.id === current.id;
  return job.workspace.name === current.name;
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
    const ws = typeof o.workspace === "object" && o.workspace !== null ? (o.workspace as Record<string, unknown>) : null;
    const workspace: WorkspaceRef | undefined = ws && typeof ws.name === "string" ? { name: ws.name, ...(typeof ws.id === "string" && ws.id ? { id: ws.id } : {}) } : undefined;
    const job: PendingJob = { generationId: o.generationId, notePath: o.notePath, title: typeof o.title === "string" ? o.title : "", format: o.format === "document" ? "document" : "slides", base: o.base, startedAt: o.startedAt };
    if (workspace) job.workspace = workspace;
    return [job];
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

/** Where a generation stands, as both Synclo's answers can say it. */
export interface ProgressInput {
  status: Status;
  /** The deck's title, when Synclo has one. */
  title: string | null;
  step: string | null;
  /** Synclo has said anything about the plan yet. */
  started: boolean;
  /** Slides planned, and how many are written. */
  total: number;
  written: number;
  /** The planned slides' titles (named in the line once planned). */
  slideTitles: string[];
  pictures: { made: number; total: number } | null;
}

/** Where a generation stands, from the job runner's answer. */
export function progressInputOf(gen: Generation | null): ProgressInput {
  const p = gen?.progress ?? null;
  return {
    status: gen?.status ?? "queued",
    title: p?.title || gen?.document?.title || null,
    step: p?.step ?? null,
    started: !!p,
    total: p?.total ?? 0,
    written: p?.written ?? 0,
    slideTitles: p?.slides.map((s) => s.title) ?? [],
    pictures: p?.pictures ?? null,
  };
}

/** What to tell the person about a generation in progress. */
export function progressText(job: PendingJob, gen: Generation | null): ProgressText {
  return progressWords(progressInputOf(gen), job.format, job.title);
}

/** The words for where a generation stands. `named` lists the first
 *  planned titles after the count. */
export function progressWords(input: ProgressInput, format: Format, fallbackTitle: string, named = true): ProgressText {
  const title = input.title || fallbackTitle || "Untitled";
  if (input.status === "queued") return { title, line: "Waiting for Synclo to start…", short: "waiting to start" };
  const total = input.total;
  const written = Math.min(input.written, total);
  if (!input.started || total === 0) {
    return input.step === "planning" || !input.started ? { title, line: `Planning the ${unit(format, 2)}…`, short: "planning" } : { title, line: "Starting…", short: "starting" };
  }
  if (written === 0) {
    const names = named ? input.slideTitles.filter(Boolean) : [];
    const shown = names.slice(0, 3).join(", ");
    const more = names.length > 3 ? "…" : "";
    return {
      title,
      line: shown ? `Planned ${total} ${unit(format, total)}: ${shown}${more}` : `Planned ${total} ${unit(format, total)}`,
      short: `planned ${total} ${unit(format, total)}`,
    };
  }
  if (written < total) return { title, line: `${written} of ${total} ${unit(format, total)} written`, short: `${written} of ${total} ${unit(format, total)}` };
  const pics = input.pictures;
  if (pics && pics.total > 0 && pics.made < pics.total) {
    return { title, line: `Adding images: ${pics.made} of ${pics.total}`, short: `images ${pics.made} of ${pics.total}` };
  }
  if (input.step === "checking") return { title, line: `Checking every ${unit(format, 1)}…`, short: "checking" };
  return { title, line: "Finishing…", short: "finishing" };
}
