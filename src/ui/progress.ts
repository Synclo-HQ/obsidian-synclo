import { Platform } from "obsidian";
import { MESSAGES, SyncloError } from "../api/errors";
import type { Generation } from "../api/synclo";
import type { SyncloHost } from "../host";
import { progressInputOf, progressWords, type PendingJob } from "../jobs/jobs";
import type { RunnerEvents } from "../jobs/runner";
import { richNotice } from "./notices";
import { noteNameOf } from "./panel-view";

interface Shown {
  job: PendingJob;
  /** A check failed for a reason that may pass: said in place of the
   *  progress until the next answer. */
  trouble: string | null;
}

/** About how long the start notice stays. */
const START_NOTICE_MS = 8_000;

/**
 * What the person sees while a presentation is made. The Synclo panel shows
 * the deck as it arrives; here, a short notice at the start when the panel
 * can't be seen (on a phone it offers Watch, which opens the panel) and, on
 * desktop, one line in the status bar that opens the panel when clicked.
 * The line reads the same progress the panel does (the progress board).
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

  /** The newest progress changed (from either answer): the line follows. */
  boardChanged(generationId: string): void {
    const s = this.shown.get(generationId);
    if (!s) return;
    s.trouble = null;
    this.renderStatus();
  }

  /** A presentation has just been started. */
  started(job: PendingJob): void {
    this.signedOutTold = false;
    this.shown.set(job.generationId, { job, trouble: null });
    this.renderStatus();
  }

  /** The start notice: on a phone always (with Watch); on a computer only
   *  when the panel couldn't be shown, since the panel opening says it. */
  startNotice(job: PendingJob): void {
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
  }

  progress(job: PendingJob, gen: Generation): void {
    if (!this.shown.has(job.generationId)) this.shown.set(job.generationId, { job, trouble: null });
    // The board says when it changed (boardChanged), here or from the panel.
    this.host.progressBoard.update(job.generationId, progressInputOf(gen));
    this.renderStatus();
  }

  trouble(job: PendingJob, error: unknown): void {
    const kind = error instanceof SyncloError ? error.kind : "network";
    this.shown.set(job.generationId, { job, trouble: kind === "network" ? "waiting for a connection" : "checking again soon" });
    this.renderStatus();
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
    const one = all.length === 1 ? all[0] : undefined;
    if (one) {
      const input = this.host.progressBoard.get(one.job.generationId) ?? progressInputOf(null);
      this.status.setText(`Synclo · ${one.trouble ?? progressWords(input, one.job.format, one.job.title).short}`);
    } else this.status.setText(`Synclo · making ${all.length} presentations`);
    this.status.setAttribute("aria-label", "Show progress");
  }
}
