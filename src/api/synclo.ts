import { parseCardState, type CardState } from "./card";
import { SyncloError } from "./errors";
import { isRecord } from "./http";
import type { McpClient } from "./mcp";

/**
 * The tools the plugin uses, with their answers checked and typed. Every
 * parser accepts what Synclo sends and ignores what it doesn't know, so a
 * server that adds fields never breaks the plugin.
 */

export type Mode = "preserve" | "condense" | "generate";
export type Format = "slides" | "document";
export type FileFormat = "pptx" | "pdf";
export type Status = "queued" | "running" | "completed" | "failed";

export interface Account {
  workspace: string;
  /** The workspace's id, when Synclo gives one. */
  workspaceId: string | null;
  balance: number | null;
  planId: string;
  slidesPerPrompt: number | null;
}

export interface Theme {
  id: string;
  name: string;
  kind: string;
  description: string;
}

export interface Progress {
  step: string | null;
  title: string | null;
  slides: Array<{ title: string; written: boolean }>;
  written: number;
  total: number;
  pictures: { made: number; total: number } | null;
}

export interface MadeDocument {
  id: string;
  title: string;
  slides: number;
  editUrl: string;
  shareUrl: string | null;
}

export interface Generation {
  id: string;
  status: Status;
  document: MadeDocument | null;
  credits: { estimated: number | null; used: number | null; remaining: number | null };
  warnings: string[];
  error: { code: string; message: string } | null;
  progress: Progress | null;
}

export interface Started {
  generationId: string;
  status: Status;
  creditsEstimated: number | null;
}

export interface Presentation {
  id: string;
  title: string;
  updatedAt: string;
  editUrl: string;
}

export interface FileLink {
  documentId: string;
  format: string;
  name: string;
  type: string;
  url: string;
  expiresAt: string | null;
}

export interface CreateArgs {
  input: string;
  mode: Mode;
  format: Format;
  slides?: number;
  theme?: string;
  image_style?: string;
  language?: string;
  instructions?: string;
}

const str = (x: unknown, fallback = ""): string => (typeof x === "string" ? x : fallback);
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

function malformed(what: string): SyncloError {
  return new SyncloError("unavailable", `Synclo sent an answer the plugin couldn't read (${what}). Try again, or update the plugin.`);
}

export function parseStatus(x: unknown): Status {
  if (x === "completed" || x === "done") return "completed";
  if (x === "failed" || x === "running" || x === "queued") return x;
  return "running";
}

export function parseProgress(x: unknown): Progress | null {
  if (!isRecord(x)) return null;
  const slides = Array.isArray(x.slides) ? x.slides.filter(isRecord).map((s) => ({ title: str(s.title).trim(), written: s.written === true })) : [];
  const pictures = isRecord(x.pictures) && num(x.pictures.made) !== null && num(x.pictures.total) !== null ? { made: num(x.pictures.made) ?? 0, total: num(x.pictures.total) ?? 0 } : null;
  return {
    step: typeof x.step === "string" ? x.step : null,
    title: typeof x.title === "string" && x.title.trim() ? x.title.trim() : null,
    slides,
    written: num(x.written) ?? slides.filter((s) => s.written).length,
    total: num(x.total) ?? slides.length,
    pictures,
  };
}

export function parseGeneration(x: Record<string, unknown>): Generation {
  if (typeof x.id !== "string") throw malformed("no generation id");
  const d = isRecord(x.document) ? x.document : null;
  const document: MadeDocument | null =
    d && typeof d.id === "string" && typeof d.edit_url === "string"
      ? { id: d.id, title: str(d.title, "Untitled"), slides: num(d.slides) ?? 0, editUrl: d.edit_url, shareUrl: typeof d.share_url === "string" ? d.share_url : null }
      : null;
  const c = isRecord(x.credits) ? x.credits : {};
  const e = isRecord(x.error) ? x.error : null;
  return {
    id: x.id,
    status: parseStatus(x.status),
    document,
    credits: { estimated: num(c.estimated), used: num(c.used), remaining: num(c.remaining) },
    warnings: Array.isArray(x.warnings) ? x.warnings.filter((w): w is string => typeof w === "string") : [],
    error: e ? { code: str(e.code, "generation_failed"), message: str(e.message, "The presentation couldn't be made.") } : null,
    progress: parseProgress(x.progress),
  };
}

export class SyncloApi {
  /** get_generation takes wait_seconds only from this plugin's connection;
   *  an older server that refuses it is asked without. */
  private waitRefused = false;

  constructor(private readonly mcp: McpClient) {}

  async account(): Promise<Account> {
    const r = await this.mcp.call("get_account", {}, { timeoutMs: 30_000 });
    const ws = isRecord(r.workspace) ? r.workspace : {};
    const credits = isRecord(r.credits) ? r.credits : {};
    const plan = isRecord(r.plan) ? r.plan : {};
    return {
      workspace: str(ws.name, "your workspace"),
      workspaceId: typeof ws.id === "string" && ws.id ? ws.id : null,
      balance: num(credits.balance),
      planId: str(plan.id),
      slidesPerPrompt: num(plan.slides_per_prompt),
    };
  }

  async themes(): Promise<Theme[]> {
    const r = await this.mcp.call("list_themes", {}, { timeoutMs: 30_000 });
    const list = Array.isArray(r.themes) ? r.themes : [];
    return list.filter(isRecord).flatMap((t) => (typeof t.id === "string" && t.id ? [{ id: t.id, name: str(t.name, t.id), kind: str(t.kind), description: str(t.description) }] : []));
  }

  async create(args: CreateArgs): Promise<Started> {
    const clean: Record<string, unknown> = { input: args.input, mode: args.mode, format: args.format };
    if (args.slides) clean.slides = args.slides;
    if (args.theme) clean.theme = args.theme;
    if (args.image_style) clean.image_style = args.image_style;
    if (args.language?.trim()) clean.language = args.language.trim().slice(0, 60);
    if (args.instructions?.trim()) clean.instructions = args.instructions.trim().slice(0, 2000);
    const r = await this.mcp.call("create_presentation", clean, { timeoutMs: 90_000 });
    if (typeof r.generation_id !== "string") throw malformed("no generation id");
    return { generationId: r.generation_id, status: parseStatus(r.status), creditsEstimated: num(r.credits_estimated) };
  }

  /** A generation's state, waiting on Synclo's side up to `waitSeconds`
   *  for it to finish. */
  async generation(id: string, waitSeconds: number): Promise<Generation> {
    const wait = Math.max(0, Math.min(40, Math.round(waitSeconds)));
    const timeoutMs = (wait + 30) * 1000;
    if (!this.waitRefused) {
      try {
        return parseGeneration(await this.mcp.call("get_generation", { generation_id: id, wait_seconds: wait }, { timeoutMs }));
      } catch (err) {
        if (!(err instanceof SyncloError && err.code === "invalid_arguments" && /wait_seconds/.test(err.message))) throw err;
        this.waitRefused = true;
      }
    }
    return parseGeneration(await this.mcp.call("get_generation", { generation_id: id }, { timeoutMs: 75_000 }));
  }

  /** How a generation's deck looks so far: each slide as written, then
   *  the finished deck's pictures. Synclo draws the finished deck inside
   *  the ask for up to about 8 seconds. (A tool Synclo doesn't list; it is
   *  the one its chat card uses.) */
  async cardState(generationId: string): Promise<CardState> {
    return parseCardState(await this.mcp.call("card_state", { generation_id: generationId }, { timeoutMs: 45_000 }));
  }

  /** Makes a file of a presentation (up to about 200 seconds). */
  async exportFile(documentId: string, format: FileFormat): Promise<FileLink> {
    const r = await this.mcp.call("export_presentation", { document_id: documentId, format }, { timeoutMs: 260_000 });
    if (typeof r.url !== "string" || !/^https?:\/\//.test(r.url)) throw malformed("no file link");
    return { documentId: str(r.document_id, documentId), format: str(r.format, format), name: str(r.name), type: str(r.type), url: r.url, expiresAt: typeof r.expires_at === "string" ? r.expires_at : null };
  }

  async search(query: string, limit = 20): Promise<Presentation[]> {
    const args: Record<string, unknown> = { limit };
    if (query.trim()) args.query = query.trim().slice(0, 200);
    const r = await this.mcp.call("search_presentations", args, { timeoutMs: 30_000 });
    const list = Array.isArray(r.presentations) ? r.presentations : [];
    return list.filter(isRecord).flatMap((p) =>
      typeof p.id === "string" && typeof p.edit_url === "string" ? [{ id: p.id, title: str(p.title, "Untitled") || "Untitled", updatedAt: str(p.updated_at), editUrl: p.edit_url }] : [],
    );
  }
}

/** The presentation id in a Synclo editor link (…/d/<id>), or null. */
export function documentIdOf(link: string): string | null {
  const m = /\/d\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i.exec(link.trim());
  return m ? (m[1] ?? "").toLowerCase() : null;
}
