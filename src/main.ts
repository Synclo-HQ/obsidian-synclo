import { MarkdownView, Notice, Platform, Plugin, TFile, normalizePath, type Editor, type MarkdownFileInfo, type Menu, type TAbstractFile } from "obsidian";
import { MESSAGES, messageFor } from "./api/errors";
import { McpClient } from "./api/mcp";
import { SyncloApi, documentIdOf, type Account, type FileFormat, type Generation, type Theme } from "./api/synclo";
import { DEFAULT_BASE, normalizeBase } from "./auth/oauth";
import { Session } from "./auth/session";
import { downloadName, fetchFile, freePath, withFileLink } from "./files";
import type { SyncloHost } from "./host";
import { parseJobs, unit, type PendingJob, type WorkspaceRef } from "./jobs/jobs";
import { ProgressBoard } from "./jobs/progress-board";
import { GIVE_UP_MS, JobRunner, type Timers } from "./jobs/runner";
import { obsidianHttp } from "./obsidian/http";
import { cardProgressInput } from "./panel/model";
import { deckStateOf, deckStateRecord } from "./panel/viewer";
import { DeckWatch } from "./panel/watch";
import { secretStore } from "./obsidian/secrets";
import { DEFAULT_SETTINGS, parseSettings, type SyncloSettings } from "./settings";
import { FindModal } from "./ui/find-modal";
import { MakeModal, makeWindowOpen } from "./ui/make-modal";
import { richContent, richNotice, type NoticeAction } from "./ui/notices";
import { DECK_VIEW, SyncloDeckView } from "./ui/deck-view";
import { PANEL_VIEW, SyncloPanelView } from "./ui/panel-view";
import { ProgressView } from "./ui/progress";
import { SyncloSettingTab } from "./ui/settings-tab";
import { presentationOf } from "./ui/views";

/** A workspace as jobs remember it. */
function workspaceOf(account: Account): WorkspaceRef {
  return account.workspaceId ? { id: account.workspaceId, name: account.workspace } : { name: account.workspace };
}

/** The frontmatter key the presentation's link is written to. */
const LINK_KEY = "synclo";
/** The list property that links the files downloaded for a note (Obsidian's
 *  file list hides PowerPoint files, so the note keeps the way to them). */
const FILES_KEY = "synclo files";
/** Presentations being made on this device (this vault's local storage). */
const JOBS_KEY = "synclo-pending-jobs";
/** The deck the Synclo panel shows (this vault's local storage). */
const PANEL_KEY = "synclo-panel-deck";
const ACCOUNT_FRESH_MS = 60_000;
const timers: Timers = { set: (fn, ms) => window.setTimeout(fn, ms), clear: (id) => window.clearTimeout(id) };

export default class SyncloPlugin extends Plugin implements SyncloHost {
  settings: SyncloSettings = { ...DEFAULT_SETTINGS };
  session!: Session;
  mcp!: McpClient;
  api!: SyncloApi;
  runner!: JobRunner;
  progressBoard = new ProgressBoard();
  private progress!: ProgressView;
  private settingsTab!: SyncloSettingTab;
  private http = obsidianHttp();
  private accountCache: { value: Account; at: number } | null = null;
  private themesCache: Theme[] | null = null;
  private downloading = false;
  /** Pictures already uploaded, by file and version. */
  private uploaded = new Map<string, string>();
  /** The deck each Synclo panel shows, asked about once for all of them. */
  private watches = new Map<string, DeckWatch>();
  /** Generations started, and found ready, while the plugin runs. */
  private startedIds = new Set<string>();
  private readyIds = new Set<string>();
  /** The workspace last learned, to notice a change. */
  private workspaceKey: string | null = null;

  async onload(): Promise<void> {
    this.settings = parseSettings(await this.loadData());
    const now = () => Date.now();
    const base = () => this.base();
    this.session = new Session({
      http: this.http,
      secrets: secretStore(this.app),
      local: { load: (key) => this.app.loadLocalStorage(key) as unknown, save: (key, value) => this.app.saveLocalStorage(key, value) },
      crypto: window.crypto,
      now,
      base,
    });
    this.mcp = new McpClient({ http: this.http, session: this.session, base, now });
    this.api = new SyncloApi(this.mcp);
    this.progress = new ProgressView(this, Platform.isDesktopApp ? this.addStatusBarItem() : null);
    this.register(this.progressBoard.onChange((id) => this.progress.boardChanged(id)));
    this.runner = new JobRunner({
      generation: (id, wait) => this.api.generation(id, wait),
      store: {
        load: () => parseJobs(this.app.loadLocalStorage(JOBS_KEY)),
        save: (jobs) => this.app.saveLocalStorage(JOBS_KEY, jobs.length ? jobs : null),
      },
      events: this.progress,
      timers,
      now,
      base,
      isSignedIn: () => this.session.isSignedIn(),
      // Phones pause apps in the background; shorter checks recover sooner.
      waitSeconds: () => (Platform.isMobile ? 15 : 30),
    });

    this.settingsTab = new SyncloSettingTab(this, this);
    this.addSettingTab(this.settingsTab);
    this.registerView(PANEL_VIEW, (leaf) => new SyncloPanelView(leaf, this));
    this.registerView(DECK_VIEW, (leaf) => new SyncloDeckView(leaf, this));
    this.registerObsidianProtocolHandler("synclo-auth", (params) => void this.onSignInReturn(params));
    this.register(
      this.session.onChange((signedIn, reason) => {
        this.accountCache = null;
        this.themesCache = null;
        this.uploaded.clear();
        // A new sign-in may be to another workspace: presentations made in
        // a workspace wait until the account says which (account() then
        // resumes them).
        this.runner.setWorkspace(null);
        // The panel asks afresh: as the new sign-in, or to say it ended.
        for (const watch of this.watches.values()) watch.restart();
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
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.runner.renamed(oldPath, file.path);
        const deck = this.panelTarget();
        if (deck?.notePath === oldPath) this.setPanelTarget({ ...deck, notePath: file.path });
      }),
    );
    // Back to the front, or back online: check on presentations at once.
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") this.backToWork();
    });
    this.registerDomEvent(window, "online", () => this.backToWork());
    this.app.workspace.onLayoutReady(() => {
      this.runner.resumeAll();
      void this.account();
    });
  }

  /** Obsidian is in front again or back online: check on presentations,
   *  and learn the workspace if it isn't known yet. */
  private backToWork(): void {
    this.runner.kick();
    if (this.session.isSignedIn() && !this.accountCache) void this.account();
  }

  onunload(): void {
    this.runner.stop();
    for (const watch of this.watches.values()) watch.stop();
    this.watches.clear();
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
    const making = this.runner.list().filter((j) => j.base === this.base());
    await this.session.signOut();
    if (making.length === 1) new Notice(`Disconnected. “${making[0]?.title || "Your presentation"}” is still being made; connect again to get its link.`);
    else if (making.length > 1) new Notice(`Disconnected. ${making.length} presentations are still being made; connect again to get their links.`);
    else new Notice("Disconnected from Synclo on this device.");
  }

  async account(force = false): Promise<Account | null> {
    if (!this.session.isSignedIn()) return null;
    if (!force && this.accountCache && Date.now() - this.accountCache.at < ACCOUNT_FRESH_MS) return this.accountCache.value;
    try {
      const value = await this.api.account();
      this.accountCache = { value, at: Date.now() };
      // Another workspace than before: the panel asks again in this one.
      const key = value.workspaceId ?? value.workspace;
      if (this.workspaceKey !== null && this.workspaceKey !== key) for (const watch of this.watches.values()) watch.restart();
      this.workspaceKey = key;
      // Presentations made in this workspace are followed; others wait,
      // untouched, until theirs is connected.
      this.runner.setWorkspace(workspaceOf(value));
      this.runner.resumeAll();
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

  panelTarget(): PendingJob | null {
    return parseJobs([this.app.loadLocalStorage(PANEL_KEY)])[0] ?? null;
  }

  private setPanelTarget(job: PendingJob): void {
    this.app.saveLocalStorage(PANEL_KEY, job);
    this.eachPanel((view) => view.show(job));
    // Only the decks a view shows, and the panel's, are watched.
    for (const [id, watch] of this.watches) {
      if (id === job.generationId || watch.inUse) continue;
      watch.stop();
      this.watches.delete(id);
    }
  }

  async openDeck(target: PendingJob, slide: number): Promise<void> {
    const { workspace } = this.app;
    // The deck's title as Synclo names it, for the tab.
    const watch = this.watches.get(target.generationId);
    const title = presentationOf(watch ?? null)?.title || watch?.card?.title || target.title;
    const state = deckStateRecord({ job: { ...target, title }, slide });
    const leaf = workspace.getLeavesOfType(DECK_VIEW).find((l) => deckStateOf(l.getViewState().state)?.job.generationId === target.generationId) ?? workspace.getLeaf("tab");
    await leaf.setViewState({ type: DECK_VIEW, state, active: true });
    await workspace.revealLeaf(leaf);
    // On a phone the panel's drawer would cover it.
    if (Platform.isMobile) {
      for (const side of [workspace.leftSplit, workspace.rightSplit]) {
        if (!side.collapsed && workspace.getLeavesOfType(PANEL_VIEW).some((l) => l.getRoot() === side)) side.collapse();
      }
    }
    if (leaf.view instanceof SyncloDeckView) leaf.view.focusSlides();
  }

  deckWatch(target: PendingJob): DeckWatch {
    let watch = this.watches.get(target.generationId);
    if (!watch) {
      watch = new DeckWatch(target, {
        ask: (id) => this.api.cardState(id),
        // Shared with the status bar; the board tells when it changed.
        onCard: (id, card) => this.progressBoard.update(id, cardProgressInput(card)),
        expired: (job) => this.givenUp(job),
        signedIn: () => this.session.isSignedIn(),
        timers,
        now: () => Date.now(),
      });
      this.watches.set(target.generationId, watch);
    }
    return watch;
  }

  /** A deck past its time, or one the job runner no longer follows and
   *  never found ready (it failed it, or gave up on it). */
  private givenUp(job: PendingJob): boolean {
    if (Date.now() - job.startedAt > GIVE_UP_MS) return true;
    return !this.readyIds.has(job.generationId) && !this.runner.list().some((j) => j.generationId === job.generationId);
  }

  /** Every open Synclo panel that is loaded (a panel not loaded yet reads
   *  its deck when it is). */
  private eachPanel(run: (view: SyncloPanelView) => void): void {
    for (const leaf of this.app.workspace.getLeavesOfType(PANEL_VIEW)) if (leaf.view instanceof SyncloPanelView) run(leaf.view);
  }

  async revealPanel(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(PANEL_VIEW)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (!leaf) return;
      // Opened beside the note, which keeps the focus.
      await leaf.setViewState({ type: PANEL_VIEW, active: false });
    }
    await workspace.revealLeaf(leaf);
  }

  /** A Synclo panel is on screen now (not closed, not behind another tab,
   *  not in a collapsed sidebar or a closed drawer). */
  private panelVisible(): boolean {
    return this.app.workspace.getLeavesOfType(PANEL_VIEW).some((leaf) => leaf.view instanceof SyncloPanelView && leaf.view.visible());
  }

  /** A Synclo panel on screen shows this deck as ready, with its actions. */
  private panelShowsReady(generationId: string): boolean {
    return this.app.workspace.getLeavesOfType(PANEL_VIEW).some((leaf) => leaf.view instanceof SyncloPanelView && leaf.view.showsReady(generationId));
  }

  makeFromActiveNote(): void {
    this.makeFromActive();
  }

  startJob(job: PendingJob): void {
    // A press found its first deck again, or an answer came late for a
    // deck already followed: the same deck, told once.
    if (this.startedIds.has(job.generationId) || this.runner.list().some((j) => j.generationId === job.generationId)) {
      this.runner.kick();
      if (!Platform.isMobile && this.panelTarget()?.generationId === job.generationId) void this.revealPanel();
      return;
    }
    this.startedIds.add(job.generationId);
    const account = this.cachedAccount();
    if (account && !job.workspace) job.workspace = workspaceOf(account);
    // The panel follows the deck made last; on a computer Make opens it.
    this.setPanelTarget(job);
    this.progress.started(job);
    this.runner.add(job);
    if (Platform.isMobile) this.progress.startNotice(job);
    else void this.openPanelFor(job);
  }

  /** Opens the panel for a deck just started; the start notice says it
   *  only if the panel didn't end up on screen (a sidebar that stayed
   *  collapsed, a view that failed to open). */
  private async openPanelFor(job: PendingJob): Promise<void> {
    try {
      await this.revealPanel();
      // Laid out first, so "on screen" is measured as drawn.
      await nextFrame();
    } catch {
      // Told below.
    }
    if (!this.panelVisible()) this.progress.startNotice(job);
  }

  noteDocumentId(file: TFile): string | null {
    const link = this.linkOf(file);
    return link ? documentIdOf(link) : null;
  }

  async onReady(job: PendingJob, gen: Generation): Promise<void> {
    const doc = gen.document;
    const id = job.generationId;
    this.accountCache = null;
    // The job runner's word reaches the panel at once, before anything is
    // awaited (the board already says ready): its presentation; and it asks
    // afresh for the finished deck's pictures.
    this.readyIds.add(id);
    const watch = this.watches.get(id);
    if (watch) {
      watch.setRunnerDocument(doc ? { id: doc.id, title: doc.title, slides: doc.slides, editUrl: doc.editUrl } : null);
      watch.restart();
    }
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
    // A panel on screen showing this deck ready says it itself; otherwise
    // (closed, behind another tab, a collapsed sidebar, a closed drawer,
    // another deck) and for a link that couldn't be written, the notice.
    if (linkWritten && this.panelShowsReady(id)) return;
    richNotice({
      title: `“${doc.title}” is ready`,
      line: `${count}.${where}${credits}`,
      detail: gen.warnings[0],
      actions: [
        { label: "Open in Synclo", primary: true, run: () => this.openExternal(doc.editUrl) },
        ...(Platform.isMobile ? [{ label: "Watch", run: () => void this.revealPanel() }] : []),
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
    // The file is named after the presentation, which only the export knows,
    // so this names no title the saved file might not carry.
    const working = richNotice({ title: `Making the ${label} file`, line: "This can take a minute or two." });
    try {
      const link = await this.api.exportFile(documentId, format);
      const bytes = await fetchFile(this.http, link.url);
      const name = downloadName(link.name, format, [title, near ? this.noteTitle(near) : ""]);
      const path = await this.savePath(name, near);
      const saved = await this.app.vault.createBinary(path, bytes);
      const linked = near ? await this.linkFile(near, saved) : false;
      working.hide();
      // With no note it belongs to, a file goes to the attachment folder.
      const attachments = !near || this.settings.saveTo === "attachments";
      const place = attachments ? "In your attachments folder" : "In the note's folder";
      const where = linked ? (attachments ? `${place}, and linked in the note's properties.` : `${place}, and linked in its properties.`) : `${place}.`;
      richNotice({
        title: `Saved “${saved.name}”`,
        line: where,
        actions: [
          {
            label: "Open",
            primary: true,
            // A PDF opens in Obsidian (in a new tab); a PowerPoint file in
            // the app the system opens it with.
            run: () => void this.app.workspace.openLinkText(saved.path, near?.path ?? "", format === "pdf"),
          },
        ],
      });
    } catch (err) {
      working.hide();
      richNotice({ title: `The ${label} file couldn't be made`, line: messageFor(err), duration: 10_000 });
    } finally {
      this.downloading = false;
    }
  }

  /** Adds a downloaded file to the note's "synclo files" property, once.
   *  Other properties are left as they are. */
  private async linkFile(note: TFile, file: TFile): Promise<boolean> {
    if (note.extension !== "md") return false;
    // The file's name when it finds the file from this note, else its path.
    const linkpath = this.app.metadataCache.getFirstLinkpathDest(file.name, note.path)?.path === file.path ? file.name : file.path;
    try {
      await this.app.fileManager.processFrontMatter(note, (fm: Record<string, unknown>) => {
        fm[FILES_KEY] = withFileLink(fm[FILES_KEY], `[[${linkpath}]]`);
      });
      return true;
    } catch {
      return false;
    }
  }

  /** A note's title: its frontmatter title, else its name. */
  private noteTitle(file: TFile): string {
    const t: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.title;
    return typeof t === "string" && t.trim() ? t.trim() : file.basename;
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
      checkCallback: (checking) => this.withLink(checking, (file, id) => void this.download(id, "pptx", file, this.noteTitle(file))),
    });
    this.addCommand({
      id: "download-pdf",
      name: "Download this note's presentation as PDF",
      checkCallback: (checking) => this.withLink(checking, (file, id) => void this.download(id, "pdf", file, this.noteTitle(file))),
    });
    this.addCommand({
      id: "open-presentation",
      name: "Open this note's presentation in your browser",
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
        .setTitle("Make a Synclo presentation")
        .setIcon("presentation")
        .onClick(() => this.make(file)),
    );
    const link = this.linkOf(file);
    if (link) {
      menu.addItem((item) =>
        item
          .setTitle("Open its presentation in Synclo")
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
          .setTitle("Make a Synclo presentation")
          .setIcon("presentation")
          .onClick(() => this.make(file)),
      );
    }
    const link = this.linkOf(file);
    if (link) {
      menu.addItem((item) =>
        item
          .setTitle("Open its presentation in Synclo")
          .setIcon("external-link")
          .onClick(() => this.openExternal(link)),
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
    // The note before the selection says whether it starts inside a code
    // block or a comment.
    new MakeModal(this, { file, selection: editor.getSelection(), selectionAtStart: from.line === 0 && from.ch === 0, before: editor.getRange({ line: 0, ch: 0 }, from) }).open();
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
        // Shown at once, then filled in when the workspace arrives.
        // With a make window open, it carries on there instead.
        const note = makeWindowOpen() ? null : this.activeNote();
        // The command's own name: a button's label never carries a note's title.
        const actions: NoticeAction[] = note ? [{ label: "Make a presentation from this note", primary: true, run: () => this.make(note) }] : [];
        const notice = richNotice({ title: "Connected to Synclo", line: "Getting your workspace…", actions });
        this.settingsTab.redraw();
        const account = await this.account(true);
        void this.themes(true).then(() => this.settingsTab.redraw());
        const line = account ? (account.balance !== null ? `${account.workspace} · ${account.balance.toLocaleString()} credits` : account.workspace) : "Ready to make presentations from your notes.";
        notice.setMessage(richContent({ title: "Connected to Synclo", line, actions }));
        this.settingsTab.redraw();
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
        new Notice(MESSAGES.signInStale);
        return;
    }
  }

  /** Where a downloaded file is saved, per the setting; a file no note is
   *  given goes to the attachment folder, from no note (not whichever note
   *  is open). */
  private async savePath(name: string, near: TFile | null): Promise<string> {
    if (!near) return this.app.fileManager.getAvailablePathForAttachment(name, "");
    if (this.settings.saveTo === "attachments") return this.app.fileManager.getAvailablePathForAttachment(name, near.path);
    const parent = near.parent;
    const folder = parent && !parent.isRoot() ? parent.path : "";
    return normalizePath(freePath(folder, name, (p) => this.app.vault.getAbstractFileByPath(normalizePath(p)) !== null));
  }
}
