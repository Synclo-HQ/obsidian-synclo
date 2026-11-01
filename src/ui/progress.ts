import { Notice, Platform } from "obsidian";
import { MESSAGES } from "../api/errors";
import type { Generation } from "../api/synclo";
import type { SyncloHost } from "../host";
import { progressText, type PendingJob } from "../jobs/jobs";
import type { RunnerEvents } from "../jobs/runner";
import { noticeContent, richNotice } from "./notices";

interface Shown {
  notice: Notice | null;
  /** The person closed it: progress stays in the status bar only. */
  dismissed: boolean;
  title: string;
  line: string;
  short: string;
}

/**
 * What the person sees while a presentation is made: a notice that
 * updates as Synclo plans and writes the slides (they can close it and
 * keep working), and on desktop a line in the status bar. A click on the
 * status bar shows the notices again.
 */
export class ProgressView implements RunnerEvents {
  private shown = new Map<string, Shown>();
  private status: HTMLElement | null;
  private signedOutTold = false;

  constructor(
    private readonly host: SyncloHost,
    statusBar: HTMLElement | null,
  ) {
    this.status = Platform.isDesktop ? statusBar : null;
    if (this.status) {
      this.status.addClass("synclo-status", "mod-clickable");
      this.status.addEventListener("click", () => this.showAgain());
      this.status.hide();
    }
  }

  /** A presentation has just been started. */
  started(job: PendingJob): void {
    this.signedOutTold = false;
    this.update(job, job.title || "Untitled", "Waiting for Synclo to start… This takes three to five minutes; you can keep working.", "waiting to start");
  }

  progress(job: PendingJob, gen: Generation): void {
    const t = progressText(job, gen);
    this.update(job, t.title, t.line, t.short);
  }

  trouble(job: PendingJob, message: string): void {
    const s = this.shown.get(job.generationId);
    this.update(job, s?.title ?? job.title, `Waiting to reach Synclo… ${message}`, "waiting for a connection");
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
    const s = this.shown.get(job.generationId);
    s?.notice?.hide();
    if (this.signedOutTold) return;
    this.signedOutTold = true;
    richNotice({
      title: "Connect Synclo again",
      line: `Your sign-in ended while “${job.title || "a presentation"}” was being made. Connect again and the link will still land in the note.`,
      actions: [{ label: "Connect", primary: true, run: () => void this.host.connect() }],
    });
  }

  /** Every notice closed and the status bar cleared (the plugin unloads). */
  clear(): void {
    for (const s of this.shown.values()) s.notice?.hide();
    this.shown.clear();
    this.renderStatus();
  }

  private update(job: PendingJob, title: string, line: string, short: string): void {
    let s = this.shown.get(job.generationId);
    if (!s) {
      s = { notice: null, dismissed: false, title, line, short };
      this.shown.set(job.generationId, s);
    }
    const changed = s.title !== title || s.line !== line || !s.notice;
    s.title = title;
    s.line = line;
    s.short = short;
    if (!s.dismissed && changed) {
      const heading = `Making “${title}”`;
      if (s.notice && s.notice.containerEl.isConnected) s.notice.setMessage(noticeContent(heading, line));
      else if (!s.notice) {
        const entry = s;
        entry.notice = new Notice(noticeContent(heading, line), 0);
        entry.notice.containerEl.addEventListener("click", () => (entry.dismissed = true));
      } else s.dismissed = true;
    }
    this.renderStatus();
  }

  private close(id: string): void {
    this.shown.get(id)?.notice?.hide();
    this.shown.delete(id);
    this.renderStatus();
  }

  private showAgain(): void {
    for (const s of this.shown.values()) {
      s.notice?.hide();
      const entry = s;
      entry.dismissed = false;
      entry.notice = new Notice(noticeContent(`Making “${s.title}”`, s.line), 0);
      entry.notice.containerEl.addEventListener("click", () => (entry.dismissed = true));
    }
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
    this.status.setText(all.length === 1 ? `Synclo: ${all[0]?.short ?? ""}` : `Synclo: making ${all.length} presentations`);
    this.status.setAttribute("aria-label", "Show progress");
  }
}
