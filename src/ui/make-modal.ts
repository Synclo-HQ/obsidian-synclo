import { Modal, Notice, Setting, type TFile } from "obsidian";
import { SyncloError, isOutOfCredits, messageFor } from "../api/errors";
import { utf8Length } from "../api/http";
import type { Format, Mode } from "../api/synclo";
import type { SyncloHost } from "../host";
import { unit } from "../jobs/jobs";
import { LIMITS, buildMaterial, previewText, withPictures, type Material } from "../material/build";
import { describeLeftOut } from "../material/left-out";
import { SOURCE_MIN_WORDS } from "../material/words";
import { vaultReader } from "../obsidian/vault";
import { IMAGE_STYLES, lengthOptions } from "../settings";

export const PRIVACY_LINE = "Only this note (and anything you chose to include) is sent to Synclo when you click Make. Nothing else in your vault is read.";
const CREDITS_PER_SLIDE = 10;

export interface MakeSource {
  file: TFile;
  /** The selected text, when making from a selection. */
  selection?: string;
  /** The selection starts at the note's first character. */
  selectionAtStart?: boolean;
}

interface Choices {
  format: Format;
  slides: number;
  keepWords: boolean;
  theme: string;
  imageStyle: string;
  includeLinked: boolean;
  language: string;
  instructions: string;
}

/**
 * The make window: what will be sent, exactly, before anything leaves the
 * vault (title, words, pictures, linked notes, and what is left out), the
 * choices, the cost in credits against the balance, then Make. Not
 * connected, it leads to Connect and comes back to the same choices.
 */
export class MakeModal extends Modal {
  private choices: Choices;
  private material: Material | null = null;
  private building: Promise<void> | null = null;
  private busy = false;
  private error: { message: string; outOfCredits: boolean; signedOut: boolean } | null = null;
  private previewOpen = false;
  private moreOpen = false;
  /** What the choices were last drawn from (to redraw only on a change). */
  private drawnFrom = "";
  private unsubscribe: (() => void) | null = null;
  private waitingForSignIn = false;

  private summaryEl!: HTMLElement;
  private bodyEl!: HTMLElement;

  constructor(
    private readonly host: SyncloHost,
    private readonly source: MakeSource,
  ) {
    super(host.app);
    const s = host.settings;
    this.choices = { format: s.format, slides: s.slides, keepWords: s.keepWords, theme: s.theme, imageStyle: s.imageStyle, includeLinked: s.includeLinked, language: "", instructions: "" };
  }

  onOpen(): void {
    this.modalEl.addClass("synclo-make");
    this.setTitle(this.choices.format === "document" ? "Make a document" : "Make a presentation");
    this.summaryEl = this.contentEl.createDiv({ cls: "synclo-summary" });
    this.bodyEl = this.contentEl.createDiv({ cls: "synclo-body" });
    this.unsubscribe = this.host.session.onChange((signedIn) => {
      this.waitingForSignIn = false;
      this.error = null;
      this.renderBody();
      if (signedIn) void this.refreshAccount();
    });
    this.renderSummary();
    this.renderBody();
    void this.rebuild();
    if (this.host.session.isSignedIn()) void this.refreshAccount();
  }

  onClose(): void {
    this.unsubscribe?.();
    this.contentEl.empty();
  }

  private async refreshAccount(): Promise<void> {
    await Promise.all([this.host.account(), this.host.themes()]);
    if (!this.busy && this.drawnFrom !== this.accountKey()) this.renderBody();
  }

  private accountKey(): string {
    return JSON.stringify([this.host.cachedAccount(), this.host.cachedThemes()?.map((t) => t.id)]);
  }

  private async rebuild(): Promise<void> {
    const run = (async () => {
      this.material = null;
      this.renderSummary();
      const text = this.source.selection ?? (await this.host.app.vault.cachedRead(this.source.file));
      const f = this.source.file;
      this.material = await buildMaterial(
        { file: { path: f.path, basename: f.basename, extension: f.extension, size: f.stat.size }, markdown: text, selection: this.source.selection !== undefined, selectionAtStart: this.source.selectionAtStart },
        vaultReader(this.host.app),
        { includeLinked: this.choices.includeLinked },
      );
      this.renderSummary();
      this.renderBody();
    })();
    this.building = run;
    try {
      await run;
    } catch {
      this.summaryEl.empty();
      this.summaryEl.createDiv({ cls: "synclo-summary-title", text: this.source.file.basename });
      this.summaryEl.createDiv({ cls: "synclo-warning", text: "This note couldn't be read. Close this window and try again." });
    } finally {
      if (this.building === run) this.building = null;
    }
  }

  /** The mode the material calls for. */
  private mode(): Mode {
    if (!this.material || this.material.sourceWords < SOURCE_MIN_WORDS) return "generate";
    return this.choices.keepWords ? "preserve" : "condense";
  }

  private renderSummary(): void {
    const el = this.summaryEl;
    el.empty();
    const m = this.material;
    el.createDiv({ cls: "synclo-summary-from", text: this.source.selection !== undefined ? "From the selection in" : "From the note" });
    if (!m) {
      el.createDiv({ cls: "synclo-summary-title", text: this.source.file.basename });
      el.createDiv({ cls: "synclo-summary-line", text: "Reading the note…" });
      return;
    }
    el.createDiv({ cls: "synclo-summary-title", text: m.title });
    const pictures = m.pictures.length + m.remotePictures;
    const parts = [`${m.words.toLocaleString()} ${m.words === 1 ? "word" : "words"}`];
    if (pictures) parts.push(`${pictures} ${pictures === 1 ? "picture" : "pictures"}`);
    if (m.linkedNotes.length) parts.push(`${m.linkedNotes.length} linked ${m.linkedNotes.length === 1 ? "note" : "notes"}`);
    el.createDiv({ cls: "synclo-summary-line", text: parts.join(" · ") });
    if (m.linkedNotes.length) el.createDiv({ cls: "synclo-summary-detail", text: `Linked notes: ${m.linkedNotes.join(", ")}` });
    const left = describeLeftOut(m.leftOut);
    if (left) el.createDiv({ cls: "synclo-summary-detail synclo-left-out", text: `Left out: ${left}` });
    if (m.mostlyLinks) el.createDiv({ cls: "synclo-hint", text: "This note is mostly links. Turn on Include linked notes to send what those notes say." });
    if (this.mode() === "generate") {
      const pics = m.pictures.length ? " Its pictures aren't sent." : "";
      el.createDiv({ cls: "synclo-hint", text: `This note is short, so Synclo will write the ${unit(this.choices.format, 2)} from it as a brief.${pics}` });
    }
    const tooLong = this.tooLong();
    if (tooLong) el.createDiv({ cls: "synclo-warning", text: tooLong });

    const toggle = el.createEl("button", { cls: "synclo-link-button", text: this.previewOpen ? "Hide the text" : "Preview the text" });
    toggle.addEventListener("click", () => {
      this.previewOpen = !this.previewOpen;
      this.renderSummary();
    });
    if (this.previewOpen) {
      const text = previewText(m);
      const shown = text.length > 20_000 ? `${text.slice(0, 20_000)}\n\n… and ${(text.length - 20_000).toLocaleString()} more characters` : text;
      el.createEl("pre", { cls: "synclo-preview", text: shown });
    }
  }

  /** Why the material can't be sent in one go, or null. */
  private tooLong(): string | null {
    const m = this.material;
    if (!m) return null;
    if (m.text.length > LIMITS.maxInputChars) {
      return `This is too long to send in one go: ${m.text.length.toLocaleString()} characters, and the limit is ${LIMITS.maxInputChars.toLocaleString()}. Make a presentation from a selection instead.`;
    }
    if (utf8Length(m.text) > LIMITS.maxBodyBytes - 16_384) return "This is too long to send in one go (the limit is 1 MB). Make a presentation from a selection instead.";
    return null;
  }

  private renderBody(): void {
    const el = this.bodyEl;
    el.empty();
    this.drawnFrom = this.accountKey();
    if (!this.host.session.isSignedIn()) {
      this.renderConnect(el);
      return;
    }
    this.renderChoices(el.createDiv({ cls: "synclo-choices" }));
    this.renderEstimate(el.createDiv({ cls: "synclo-estimate" }));
    if (this.error) this.renderError(el.createDiv({ cls: "synclo-error" }));
    el.createDiv({ cls: "synclo-privacy", text: PRIVACY_LINE });
    this.renderButtons(el.createDiv({ cls: "synclo-buttons" }));
  }

  private renderConnect(el: HTMLElement): void {
    this.host.prepareConnect();
    const box = el.createDiv({ cls: "synclo-connect" });
    if (this.waitingForSignIn) {
      box.createDiv({ text: "Finish signing in in your browser. This window picks up where you left off when you come back." });
    } else {
      box.createDiv({ text: "Connect Synclo to make presentations from your notes. You sign in at synclo.app; a free account comes with 400 credits." });
    }
    el.createDiv({ cls: "synclo-privacy", text: PRIVACY_LINE });
    const row = el.createDiv({ cls: "synclo-buttons" });
    const connect = row.createEl("button", { cls: "mod-cta", text: this.waitingForSignIn ? "Open the sign-in page again" : "Connect" });
    connect.addEventListener("click", () => {
      this.waitingForSignIn = true;
      this.renderBody();
      void this.host.connect();
    });
    row.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
  }

  private renderChoices(el: HTMLElement): void {
    const c = this.choices;
    const account = this.host.cachedAccount();
    const generate = this.mode() === "generate";

    new Setting(el).setName("Format").addDropdown((d) =>
      d
        .addOptions({ slides: "Slides", document: "Document" })
        .setValue(c.format)
        .onChange((v) => {
          c.format = v === "document" ? "document" : "slides";
          this.setTitle(c.format === "document" ? "Make a document" : "Make a presentation");
          this.renderSummary();
          this.renderBody();
        }),
    );

    const options = lengthOptions(account?.slidesPerPrompt ?? null, c.slides);
    if (!options.includes(c.slides)) c.slides = options[options.length - 1] ?? 8;
    const length = new Setting(el).setName("Length").addDropdown((d) => {
      for (const n of options) d.addOption(String(n), `${generate ? "" : "Up to "}${n} ${unit(c.format, n)}`);
      d.setValue(String(c.slides)).onChange((v) => {
        c.slides = Number(v);
        this.renderBody();
      });
    });
    if (account?.slidesPerPrompt) length.setDesc(`Your plan makes up to ${account.slidesPerPrompt} ${unit(c.format, account.slidesPerPrompt)} at a time.`);

    if (!generate) {
      new Setting(el)
        .setName("Words")
        .setDesc(c.keepWords ? "Every word of the note is kept as written." : "Synclo tightens the wording and keeps every fact.")
        .addDropdown((d) =>
          d
            .addOptions({ condense: "Let Synclo condense", preserve: "Keep my words" })
            .setValue(c.keepWords ? "preserve" : "condense")
            .onChange((v) => {
              c.keepWords = v === "preserve";
              this.renderBody();
            }),
        );
    }

    const themes = this.host.cachedThemes();
    new Setting(el).setName("Theme").addDropdown((d) => {
      d.addOption("", "Designed for this note");
      for (const t of themes ?? []) d.addOption(t.id, t.name);
      if (c.theme && !(themes ?? []).some((t) => t.id === c.theme)) d.addOption(c.theme, "Your saved theme");
      d.setValue(c.theme).onChange((v) => (c.theme = v));
    });

    new Setting(el).setName("Pictures").addDropdown((d) => {
      for (const [id, label] of IMAGE_STYLES) d.addOption(id, label);
      d.setValue(IMAGE_STYLES.some(([id]) => id === c.imageStyle) ? c.imageStyle : "theme").onChange((v) => (c.imageStyle = v));
    });

    new Setting(el)
      .setName("Include linked notes")
      .setDesc("Also send the notes this note links to, one level deep.")
      .addToggle((t) =>
        t.setValue(c.includeLinked).onChange((v) => {
          c.includeLinked = v;
          void this.rebuild();
        }),
      );

    const more = el.createEl("details", { cls: "synclo-more" });
    more.open = this.moreOpen;
    more.addEventListener("toggle", () => (this.moreOpen = more.open));
    more.createEl("summary", { text: "More choices" });
    new Setting(more)
      .setName("Language")
      .setDesc("Leave empty to use the note's language.")
      .addText((t) =>
        t
          .setPlaceholder("Same as the note")
          .setValue(c.language)
          .onChange((v) => (c.language = v)),
      );
    new Setting(more)
      .setName("Instructions")
      .setDesc("Anything Synclo should know, such as who it's for.")
      .addTextArea((t) => {
        t.setPlaceholder("For the board, focus on the results")
          .setValue(c.instructions)
          .onChange((v) => (c.instructions = v));
        t.inputEl.maxLength = 2000;
        t.inputEl.rows = 3;
      });
  }

  private credits(): number {
    return this.choices.slides * CREDITS_PER_SLIDE;
  }

  private renderEstimate(el: HTMLElement): void {
    const c = this.choices;
    const balance = this.host.cachedAccount()?.balance ?? null;
    const upTo = this.mode() === "generate" ? "" : "up to ";
    const line = `Costs ${upTo}${this.credits().toLocaleString()} credits (${CREDITS_PER_SLIDE} a ${unit(c.format, 1)}).${balance !== null ? ` You have ${balance.toLocaleString()}.` : ""}`;
    el.createDiv({ text: line });
    if (balance !== null && balance < this.credits()) {
      const warn = el.createDiv({ cls: "synclo-warning" });
      warn.appendText(balance < CREDITS_PER_SLIDE ? "You're out of credits. " : `That's more than your ${balance.toLocaleString()} credits. Choose fewer ${unit(c.format, 2)}, or `);
      const a = warn.createEl("a", { text: balance < CREDITS_PER_SLIDE ? "Get more at synclo.app" : "get more at synclo.app", href: this.host.creditsUrl() });
      a.addEventListener("click", (e) => {
        e.preventDefault();
        this.host.openExternal(this.host.creditsUrl());
      });
      warn.appendText(".");
    }
  }

  private renderError(el: HTMLElement): void {
    const e = this.error;
    if (!e) return;
    el.setAttribute("role", "alert");
    el.createDiv({ text: e.message });
    if (e.outOfCredits) {
      el.createEl("button", { text: "Get more credits" }).addEventListener("click", () => this.host.openExternal(this.host.creditsUrl()));
    }
    if (e.signedOut) {
      this.host.prepareConnect();
      el.createEl("button", { text: "Connect again" }).addEventListener("click", () => {
        this.waitingForSignIn = true;
        void this.host.connect();
      });
    }
  }

  private renderButtons(el: HTMLElement): void {
    const balance = this.host.cachedAccount()?.balance ?? null;
    const blocked = !this.material || !!this.tooLong() || (balance !== null && balance < this.credits());
    const make = el.createEl("button", { cls: "mod-cta", text: this.busyText ?? "Make" });
    make.disabled = this.busy || blocked;
    make.addEventListener("click", () => void this.make());
    const cancel = el.createEl("button", { text: "Cancel" });
    cancel.disabled = this.busy;
    cancel.addEventListener("click", () => this.close());
  }

  private busyText: string | null = null;

  private setBusy(text: string | null): void {
    this.busy = text !== null;
    this.busyText = text;
    this.renderBody();
  }

  private async make(): Promise<void> {
    if (this.busy) return;
    if (this.building) await this.building;
    const m = this.material;
    if (!m || this.tooLong()) return;
    this.error = null;
    const c = this.choices;
    const mode = this.mode();
    try {
      // The note's own pictures go first, only now that Make was clicked.
      const urls = new Map<number, string>();
      let skipped = 0;
      if (mode !== "generate" && m.pictures.length) {
        for (const [i, pic] of m.pictures.entries()) {
          this.setBusy(`Sending pictures (${i + 1} of ${m.pictures.length})…`);
          const file = this.host.app.vault.getFileByPath(pic.file.path);
          if (!file) {
            skipped++;
            continue;
          }
          try {
            urls.set(pic.n, await this.host.mcp.uploadPicture(await this.host.app.vault.readBinary(file), pic.type));
          } catch (err) {
            if (err instanceof SyncloError && err.kind === "rejected") skipped++;
            else if (err instanceof SyncloError && err.kind === "rate-limited") {
              skipped += m.pictures.length - i;
              break;
            } else throw err;
          }
        }
      }
      const input = mode === "generate" ? withPictures(m, new Map()) : withPictures(m, urls);
      if (input.length > LIMITS.maxInputChars) throw new SyncloError("too-large", "With its pictures this is too long to send in one go. Make a presentation from a selection instead.");
      this.setBusy("Starting…");
      const started = await this.host.api.create({
        input,
        mode,
        format: c.format,
        slides: c.slides,
        theme: c.theme || undefined,
        image_style: c.imageStyle && c.imageStyle !== "theme" ? c.imageStyle : undefined,
        language: c.language || undefined,
        instructions: c.instructions || undefined,
      });
      const already = this.host.runner.list().some((j) => j.generationId === started.generationId);
      this.host.startJob({ generationId: started.generationId, notePath: this.source.file.path, title: m.title, format: c.format, base: this.host.base(), startedAt: Date.now() });
      this.busy = false;
      this.close();
      if (already) this.host.runner.kick();
      if (skipped) new Notice(`${skipped} of the note's pictures couldn't be sent, so Synclo is making it without them.`);
    } catch (err) {
      this.busy = false;
      this.busyText = null;
      this.error = {
        message: messageFor(err),
        outOfCredits: isOutOfCredits(err),
        signedOut: err instanceof SyncloError && err.kind === "signed-out",
      };
      if (isOutOfCredits(err)) void this.host.account(true);
      this.renderBody();
    }
  }
}
