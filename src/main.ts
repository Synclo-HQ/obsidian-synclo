import { MarkdownView, Notice, Platform, Plugin, TFile, normalizePath, type Editor, type MarkdownFileInfo, type Menu, type TAbstractFile } from "obsidian";
import { messageFor } from "./api/errors";
import { McpClient } from "./api/mcp";
import { SyncloApi, documentIdOf, type Account, type FileFormat, type Generation, type Theme } from "./api/synclo";
import { DEFAULT_BASE, normalizeBase } from "./auth/oauth";
import { Session } from "./auth/session";
import { fetchFile, freePath, safeFileName } from "./files";
import type { SyncloHost } from "./host";
import { parseJobs, unit, type PendingJob } from "./jobs/jobs";
import { JobRunner } from "./jobs/runner";
import { obsidianHttp } from "./obsidian/http";
import { secretStore } from "./obsidian/secrets";
import { DEFAULT_SETTINGS, parseSettings, type SyncloSettings } from "./settings";
import { FindModal } from "./ui/find-modal";
import { MakeModal } from "./ui/make-modal";
import { richNotice } from "./ui/notices";
import { ProgressView } from "./ui/progress";
import { SyncloSettingTab } from "./ui/settings-tab";

/** The frontmatter key the presentation's link is written to. */
const LINK_KEY = "synclo";
/** Presentations being made on this device (this vault's local storage). */
const JOBS_KEY = "synclo-pending-jobs";
const ACCOUNT_FRESH_MS = 60_000;

export default class SyncloPlugin extends Plugin implements SyncloHost {
  settings: SyncloSettings = { ...DEFAULT_SETTINGS };
  session!: Session;
  mcp!: McpClient;
  api!: SyncloApi;
  runner!: JobRunner;
  private progress!: ProgressView;
  private http = obsidianHttp();
  private accountCache: { value: Account; at: number } | null = null;
  private themesCache: Theme[] | null = null;
  private downloading = false;
  /** Pictures already uploaded, by file and version. */
  private uploaded = new Map<string, string>();

  async onload(): Promise<void> {
    this.settings = parseSettings(await this.loadData());
    const now = () => Date.now();
    const base = () => this.base();
    this.session = new Session({ http: this.http, secrets: secretStore(this.app), crypto: window.crypto, now, base });
    this.mcp = new McpClient({ http: this.http, session: this.session, base, now });
    this.api = new SyncloApi(this.mcp);
    this.progress = new ProgressView(this, Platform.isDesktop ? this.addStatusBarItem() : null);
    this.runner = new JobRunner({
      generation: (id, wait) => this.api.generation(id, wait),
      store: {
        load: () => parseJobs(this.app.loadLocalStorage(JOBS_KEY)),
        save: (jobs) => this.app.saveLocalStorage(JOBS_KEY, jobs.length ? jobs : null),
      },
      events: this.progress,
      timers: { set: (fn, ms) => window.setTimeout(fn, ms), clear: (id) => window.clearTimeout(id) },
      now,
      base,
      isSignedIn: () => this.session.isSignedIn(),
      // Phones pause apps in the background; shorter checks recover sooner.
      waitSeconds: () => (Platform.isMobile ? 15 : 30),
    });

    this.addSettingTab(new SyncloSettingTab(this, this));
    this.registerObsidianProtocolHandler("synclo-auth", (params) => void this.onSignInReturn(params));
    this.register(
      this.session.onChange((signedIn, reason) => {
        this.accountCache = null;
        this.themesCache = null;
        this.uploaded.clear();
        if (signedIn) {
          this.progress.signedIn();
          this.runner.resumeAll();
        } else if (reason === "expired" && !this.runner.list().some((j) => j.base === this.base())) {
          // With presentations waiting, their notice says it instead.
          this.prepareConnect();
          richNotice({ title: "Your Synclo sign-in has ended", line: "Connect again to keep making presentations.", actions: [{ label: "Connect", primary: true, run: () => void this.connect() }] });
        }
      }),
    );

    this.addCommands();
    this.addRibbonIcon("presentation", "Make a presentation from this note", () => this.makeFromActive());
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => this.fileMenu(menu, file)));
    this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor, info) => this.editorMenu(menu, editor, info)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.runner.renamed(oldPath, file.path)));
    // Back to the front, or back online: check on presentations at once.
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") this.runner.kick();
    });
    this.registerDomEvent(window, "online", () => this.runner.kick());
    this.app.workspace.onLayoutReady(() => this.runner.resumeAll());
  }

  onunload(): void {
    this.runner.stop();
    this.progress.clear();
  }

  /* ── SyncloHost ──────────────────────────────────────────────────────── */

  base(): string {
    return normalizeBase(this.settings.base) ?? DEFAULT_BASE;
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async connect(): Promise<void> {
    try {
      // Opened in the same moment as the click when a sign-in is ready.
      const url = this.session.takePreparedSignIn() ?? (await this.session.startSignIn(this.app.vault.getName()));
      window.open(url);
      this.prepareConnect();
    } catch (err) {
      new Notice(`Synclo couldn't start signing in. ${messageFor(err)}`);
    }
  }

  prepareConnect(): void {
    if (!this.session.isSignedIn()) void this.session.prepareSignIn(this.app.vault.getName()).catch(() => undefined);
  }

  async disconnect(): Promise<void> {
    await this.session.signOut();
    new Notice("Disconnected from Synclo on this device.");
  }

  async account(force = false): Promise<Account | null> {
    if (!this.session.isSignedIn()) return null;
    if (!force && this.accountCache && Date.now() - this.accountCache.at < ACCOUNT_FRESH_MS) return this.accountCache.value;
    try {
      const value = await this.api.account();
      this.accountCache = { value, at: Date.now() };
      return value;
    } catch {
      return this.accountCache?.value ?? null;
    }
  }

  cachedAccount(): Account | null {
    return this.session.isSignedIn() ? (this.accountCache?.value ?? null) : null;
  }

  async themes(force = false): Promise<Theme[] | null> {
    if (!this.session.isSignedIn()) return null;
    if (this.themesCache && !force) return this.themesCache;
    try {
      this.themesCache = await this.api.themes();
    } catch {
      // Keep what we had; the window offers "Designed for this note".
    }
    return this.themesCache;
  }

  cachedThemes(): Theme[] | null {
    return this.session.isSignedIn() ? this.themesCache : null;
  }

  openExternal(url: string): void {
    if (/^https?:\/\//i.test(url)) window.open(url);
  }

  creditsUrl(): string {
    return `${this.base()}/pricing`;
  }

  async uploadPicture(file: TFile, type: string): Promise<string> {
    const key = `${this.base()}|${file.path}|${file.stat.mtime}|${file.stat.size}`;
    const known = this.uploaded.get(key);
    if (known) return known;
    const url = await this.mcp.uploadPicture(await this.app.vault.readBinary(file), type);
    this.uploaded.set(key, url);
    return url;
  }

  startJob(job: PendingJob): void {
    this.progress.started(job);
    this.runner.add(job);
  }

  async onReady(job: PendingJob, gen: Generation): Promise<void> {
    const doc = gen.document;
    this.accountCache = null;
    if (!doc) {
      richNotice({ title: `“${job.title}” is ready`, line: "Open Synclo to see it." });
      return;
    }
    const file = this.app.vault.getFileByPath(job.notePath);
    let linkWritten = false;
    if (file && file.extension === "md") {
      try {
        await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
          fm[LINK_KEY] = doc.editUrl;
        });
        linkWritten = true;
      } catch {
        linkWritten = false;
      }
    }
    const count = `${doc.slides} ${unit(job.format, doc.slides)}`;
    const credits = gen.credits.used !== null ? ` Used ${gen.credits.used.toLocaleString()} credits${gen.credits.remaining !== null ? `; ${gen.credits.remaining.toLocaleString()} left` : ""}.` : "";
    const where = linkWritten
      ? " The link is in the note's properties."
      : file
        ? " The link couldn't be written into the note's properties; check that they are valid."
        : " The note was moved out of the vault or deleted, so the link wasn't written.";
    richNotice({
      title: `“${doc.title}” is ready`,
      line: `${count}.${where}${credits}`,
      detail: gen.warnings[0],
      actions: [
        { label: "Open in Synclo", primary: true, run: () => this.openExternal(doc.editUrl) },
        { label: "Download PowerPoint", run: () => void this.download(doc.id, "pptx", file, doc.title) },
        { label: "Download PDF", run: () => void this.download(doc.id, "pdf", file, doc.title) },
      ],
    });
  }

  async download(documentId: string, format: FileFormat, near: TFile | null, title: string): Promise<void> {
    const label = format === "pptx" ? "PowerPoint" : "PDF";
    if (!this.session.isSignedIn()) {
      this.askToConnect();
      return;
    }
    if (this.downloading) {
      new Notice("A file is already being made. Try again when it's done.");
      return;
    }
    this.downloading = true;
    const working = richNotice({ title: `Making the ${label} file`, line: `“${title}”. This can take a minute or two.` });
    try {
      const link = await this.api.exportFile(documentId, format);
      const bytes = await fetchFile(this.http, link.url);
      const name = safeFileName(link.name || title, format, title || "Presentation");
      const path = await this.savePath(name, near);
      const saved = await this.app.vault.createBinary(path, bytes);
      working.hide();
      const folder = saved.parent && !saved.parent.isRoot() ? saved.parent.path : "the vault's top folder";
      richNotice({
        title: `Saved “${saved.name}”`,
        line: `In ${folder}.`,
        duration: 10_000,
        actions: format === "pdf" ? [{ label: "Open", run: () => void this.app.workspace.getLeaf(true).openFile(saved) }] : [],
      });
    } catch (err) {
      working.hide();
      richNotice({ title: `The ${label} file couldn't be made`, line: messageFor(err), duration: 10_000 });
    } finally {
      this.downloading = false;
    }
  }

  /* ── Commands, menus, sign-in ───────────────────────────────────────── */

  private addCommands(): void {
    this.addCommand({
      id: "make-from-note",
      name: "Make a presentation from this note",
      checkCallback: (checking) => {
        const file = this.activeNote();
        if (!file) return false;
        if (!checking) this.make(file);
        return true;
      },
    });
    this.addCommand({
      id: "make-from-selection",
      name: "Make a presentation from the selection",
      editorCheckCallback: (checking, editor, info) => {
        const file = info.file;
        if (!file || file.extension !== "md" || !editor.somethingSelected()) return false;
        if (!checking) this.makeFromSelection(editor, file);
        return true;
      },
    });
    this.addCommand({
      id: "download-pptx",
      name: "Download this note's presentation as PowerPoint",
      checkCallback: (checking) => this.withLink(checking, (file, id) => void this.download(id, "pptx", file, file.basename)),
    });
    this.addCommand({
      id: "download-pdf",
      name: "Download this note's presentation as PDF",
      checkCallback: (checking) => this.withLink(checking, (file, id) => void this.download(id, "pdf", file, file.basename)),
    });
    this.addCommand({
      id: "open-presentation",
      name: "Open this note's presentation",
      checkCallback: (checking) => this.withLink(checking, (file) => this.openExternal(this.linkOf(file) ?? "")),
    });
    this.addCommand({
      id: "find-presentation",
      name: "Find a presentation",
      callback: () => this.find(),
    });
  }

  private fileMenu(menu: Menu, file: TAbstractFile): void {
    if (!(file instanceof TFile) || file.extension !== "md") return;
    menu.addItem((item) =>
      item
        .setTitle("Make a presentation with Synclo")
        .setIcon("presentation")
        .onClick(() => this.make(file)),
    );
    const link = this.linkOf(file);
    if (link) {
      menu.addItem((item) =>
        item
          .setTitle("Open presentation in Synclo")
          .setIcon("external-link")
          .onClick(() => this.openExternal(link)),
      );
    }
  }

  private editorMenu(menu: Menu, editor: Editor, info: MarkdownView | MarkdownFileInfo): void {
    const file = info.file;
    if (!file || file.extension !== "md") return;
    if (editor.somethingSelected()) {
      menu.addItem((item) =>
        item
          .setTitle("Make a Synclo presentation from the selection")
          .setIcon("presentation")
          .onClick(() => this.makeFromSelection(editor, file)),
      );
    } else {
      menu.addItem((item) =>
        item
          .setTitle("Make a presentation with Synclo")
          .setIcon("presentation")
          .onClick(() => this.make(file)),
      );
    }
  }

  private activeNote(): TFile | null {
    const file = this.app.workspace.getActiveFile();
    return file && file.extension === "md" ? file : null;
  }

  private makeFromActive(): void {
    const file = this.activeNote();
    if (!file) {
      new Notice("Open a note first, then make a presentation from it.");
      return;
    }
    this.make(file);
  }

  private make(file: TFile): void {
    new MakeModal(this, { file }).open();
  }

  private makeFromSelection(editor: Editor, file: TFile): void {
    const from = editor.getCursor("from");
    new MakeModal(this, { file, selection: editor.getSelection(), selectionAtStart: from.line === 0 && from.ch === 0 }).open();
  }

  private find(): void {
    if (!this.session.isSignedIn()) {
      this.askToConnect();
      return;
    }
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    new FindModal(this, { editor: view?.editor ?? null, file: view?.file ?? this.app.workspace.getActiveFile() }).open();
  }

  /** The presentation link in a note's properties, when it is one. */
  private linkOf(file: TFile): string | null {
    const value: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.[LINK_KEY];
    const link: unknown = Array.isArray(value) ? value.find((v): v is string => typeof v === "string") : value;
    return typeof link === "string" && /^https?:\/\//i.test(link.trim()) && documentIdOf(link) ? link.trim() : null;
  }

  private withLink(checking: boolean, run: (file: TFile, documentId: string) => void): boolean {
    const file = this.activeNote();
    const link = file ? this.linkOf(file) : null;
    const id = link ? documentIdOf(link) : null;
    if (!file || !id) return false;
    if (!checking) run(file, id);
    return true;
  }

  private askToConnect(): void {
    this.prepareConnect();
    richNotice({
      title: "Connect Synclo first",
      line: "Sign in at synclo.app; a free account comes with 400 credits.",
      duration: 10_000,
      actions: [{ label: "Connect", primary: true, run: () => void this.connect() }],
    });
  }

  private async onSignInReturn(params: Record<string, string>): Promise<void> {
    const vault = this.app.vault.getName();
    const result = await this.session.finishSignIn(params, vault);
    switch (result.kind) {
      case "connected": {
        const account = await this.account(true);
        void this.themes(true);
        new Notice(account ? `Connected to Synclo: ${account.workspace}.` : "Connected to Synclo.");
        return;
      }
      case "declined":
        new Notice("Synclo wasn't connected.");
        return;
      case "failed":
        this.prepareConnect();
        richNotice({ title: "Synclo couldn't connect", line: result.message, duration: 10_000, actions: [{ label: "Try again", run: () => void this.connect() }] });
        return;
      case "elsewhere": {
        // Obsidian gave the answer to the vault in front; pass it to the
        // vault that asked.
        const q = new URLSearchParams({ vault: result.vault });
        for (const key of ["code", "state", "iss", "error", "error_description"]) if (params[key]) q.set(key, params[key] ?? "");
        window.open(`obsidian://synclo-auth?${q.toString()}`);
        return;
      }
      case "stale":
        new Notice("That sign-in link was already used or has expired. Connect again from the plugin's settings.");
        return;
    }
  }

  /** Where a downloaded file is saved, per the setting. */
  private async savePath(name: string, near: TFile | null): Promise<string> {
    if (this.settings.saveTo === "attachments") return this.app.fileManager.getAvailablePathForAttachment(name, near?.path);
    const parent = near?.parent;
    const folder = parent && !parent.isRoot() ? parent.path : "";
    return normalizePath(freePath(folder, name, (p) => this.app.vault.getAbstractFileByPath(normalizePath(p)) !== null));
  }
}
