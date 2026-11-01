import { Platform } from "obsidian";
import { MESSAGES, SyncloError } from "../api/errors";
import type { Generation } from "../api/synclo";
import type { SyncloHost } from "../host";
import { progressText, type PendingJob } from "../jobs/jobs";
import type { RunnerEvents } from "../jobs/runner";
import { richNotice } from "./notices";
import { noteNameOf } from "./panel-view";

interface Shown {
  title: string;
  short: string;
}

/** About how long the start notice stays. */
const START_NOTICE_MS = 8_000;

/**
 * What the person sees while a presentation is made. The Synclo panel shows
 * the deck as it arrives; here, a short notice at the start (on a phone it
 * offers Watch, which opens the panel) and, on desktop, one line in the
 * status bar that opens the panel when clicked.
 */
export class ProgressView implements RunnerEvents {
  private shown = new Map<string, Shown>();
  private status: HTMLElement | null;
  private signedOutTold = false;

  constructor(
    private readonly host: SyncloHost,
    statusBar: HTMLElement | null,
  ) {
    this.status = Platform.isDesktopApp ? statusBar : null;
    if (this.status) {
      this.status.addClass("synclo-status", "mod-clickable");
      this.status.addEventListener("click", () => void this.host.revealPanel());
      this.status.hide();
    }
  }

  /** A presentation has just been started. */
  started(job: PendingJob): void {
    this.signedOutTold = false;
    const name = noteNameOf(job.notePath);
    if (Platform.isMobile) {
      richNotice({
        title: `Making “${name}”`,
        line: "It takes about three minutes.",
        duration: START_NOTICE_MS,
        actions: [{ label: "Watch", primary: true, run: () => void this.host.revealPanel() }],
      });
    } else {
      richNotice({ title: `Making “${name}”`, line: "Follow it in the Synclo panel.", duration: START_NOTICE_MS });
    }
    this.update(job, job.title || name, "waiting to start");
  }

  progress(job: PendingJob, gen: Generation): void {
    const t = progressText(job, gen);
    this.update(job, t.title, t.short);
  }

  trouble(job: PendingJob, error: unknown): void {
    const kind = error instanceof SyncloError ? error.kind : "network";
    this.update(job, this.shown.get(job.generationId)?.title ?? job.title, kind === "network" ? "waiting for a connection" : "checking again soon");
  }

  async ready(job: PendingJob, gen: Generation): Promise<void> {
    this.close(job.generationId);
    await this.host.onReady(job, gen);
  }

  failed(job: PendingJob, error: { code: string; message: string }): void {
    this.close(job.generationId);
    const title = `Synclo couldn't make “${job.title || "Untitled"}”`;
    if (error.code === "insufficient_credits") {
      richNotice({ title, line: MESSAGES.outOfCredits, actions: [{ label: "Get more credits", primary: true, run: () => this.host.openExternal(this.host.creditsUrl()) }] });
      return;
    }
    richNotice({ title, line: error.message || "Try making it again." });
  }

  signedOut(job: PendingJob): void {
    this.close(job.generationId);
    if (this.signedOutTold) return;
    this.signedOutTold = true;
    this.host.prepareConnect();
    richNotice({
      title: "Connect Synclo to finish",
      line: `“${job.title || "Your presentation"}” is still being made. Connect again and its link lands in the note when it's ready.`,
      actions: [{ label: "Connect", primary: true, run: () => void this.host.connect() }],
    });
  }

  /** Connected again: a later sign-out is told again. */
  signedIn(): void {
    this.signedOutTold = false;
  }

  /** The status bar cleared (the plugin unloads). */
  clear(): void {
    this.shown.clear();
    this.renderStatus();
  }

  private update(job: PendingJob, title: string, short: string): void {
    this.shown.set(job.generationId, { title, short });
    this.renderStatus();
  }

  private close(id: string): void {
    this.shown.delete(id);
    this.renderStatus();
  }

  private renderStatus(): void {
    if (!this.status) return;
    const all = [...this.shown.values()];
    if (!all.length) {
      this.status.hide();
      this.status.setText("");
      return;
    }
    this.status.show();
    this.status.setText(all.length === 1 ? `Synclo · ${all[0]?.short ?? ""}` : `Synclo · making ${all.length} presentations`);
    this.status.setAttribute("aria-label", "Show progress");
  }
}
