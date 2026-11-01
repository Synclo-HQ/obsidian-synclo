import type { App, TFile } from "obsidian";
import type { McpClient } from "./api/mcp";
import type { Account, FileFormat, Generation, SyncloApi, Theme } from "./api/synclo";
import type { Session } from "./auth/session";
import type { PendingJob } from "./jobs/jobs";
import type { JobRunner } from "./jobs/runner";
import type { SyncloSettings } from "./settings";

/** What the windows and notices need from the plugin. */
export interface SyncloHost {
  app: App;
  settings: SyncloSettings;
  session: Session;
  api: SyncloApi;
  mcp: McpClient;
  runner: JobRunner;
  base(): string;
  saveSettings(): Promise<void>;
  /** Opens Synclo's sign-in in the browser. */
  connect(): Promise<void>;
  /** Gets a sign-in ready, for a Connect button about to be shown. */
  prepareConnect(): void;
  disconnect(): Promise<void>;
  /** The workspace, its credits and plan; cached for a minute. */
  account(force?: boolean): Promise<Account | null>;
  cachedAccount(): Account | null;
  /** The themes a presentation can use; cached for the session. */
  themes(force?: boolean): Promise<Theme[] | null>;
  cachedThemes(): Theme[] | null;
  /** Uploads one of a note's pictures; the same file unchanged is sent
   *  once, so trying again sends the very same request. */
  uploadPicture(file: TFile, type: string): Promise<string>;
  /** Makes a file of a presentation and saves it in the vault: next to
   *  `near` (or in the attachment folder, per the setting) with a link in
   *  its properties; with no note, in the attachment folder only. */
  download(documentId: string, format: FileFormat, near: TFile | null, title: string): Promise<void>;
  /** The presentation a note's properties link to, or null. */
  noteDocumentId(file: TFile): string | null;
  openExternal(url: string): void;
  /** Where to get more credits. */
  creditsUrl(): string;
  /** Starts following a presentation being made. */
  startJob(job: PendingJob): void;
  /** Writes the link into the note and says the presentation is ready. */
  onReady(job: PendingJob, gen: Generation): Promise<void>;
  /** The deck the Synclo panel shows: the one made last in this vault. */
  panelTarget(): PendingJob | null;
  /** Opens the Synclo panel (or brings it forward). */
  revealPanel(): Promise<void>;
  /** Opens the make window for the note in front. */
  makeFromActiveNote(): void;
}
