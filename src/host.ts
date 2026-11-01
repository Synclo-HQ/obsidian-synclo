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
  /** Makes a file of a presentation and saves it in the vault. */
  download(documentId: string, format: FileFormat, near: TFile | null, title: string): Promise<void>;
  openExternal(url: string): void;
  /** Where to get more credits. */
  creditsUrl(): string;
  /** Starts following a presentation being made. */
  startJob(job: PendingJob): void;
  /** Writes the link into the note and says the presentation is ready. */
  onReady(job: PendingJob, gen: Generation): Promise<void>;
}
