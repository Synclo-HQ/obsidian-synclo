import { Modal, Notice, Setting, setIcon, type TFile } from "obsidian";
import { SyncloError, isOutOfCredits, messageFor } from "../api/errors";
import { utf8Length } from "../api/http";
import type { Format, Mode } from "../api/synclo";
import type { SyncloHost } from "../host";
import { richNotice } from "./notices";
import { unit } from "../jobs/jobs";
import { LIMITS, buildMaterial, previewText, withPictures, type Material } from "../material/build";
import { describeLeftOut } from "../material/left-out";
import { SOURCE_MIN_WORDS } from "../material/words";
import { vaultReader } from "../obsidian/vault";
import { IMAGE_STYLES, lengthOptions } from "../settings";

/** Make windows open now (the Connected notice offers Make only when none
 *  is). */
let openWindows = 0;
export function makeWindowOpen(): boolean {
  return openWindows > 0;
}

/** A control's name on its element, so a redraw can give it focus back. */
const CONTROL = "data-synclo-control";

export const PRIVACY_LINE = "Only what's shown above is sent to Synclo, and only when you click Make. Nothing else in your vault is read.";
const CREDITS_PER_SLIDE = 10;

export interface MakeSource {
  file: TFile;
  /** The selected text, when making from a selection. */
  selection?: string;
  /** The selection starts at the note's first character. */
  selectionAtStart?: boolean;
  /** The note's text before the selection. */
  before?: string;
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
  /** `reconnect`: the sign-in ended, or this connection may no longer do
   *  this; connecting again is the way on. */
  private error: { message: string; outOfCredits: boolean; reconnect: boolean } | null = null;
  private previewOpen = false;
  private moreOpen = false;
  /** What the choices were last drawn from (to redraw only on a change). */
  private drawnFrom = "";
  private unsubscribe: (() => void) | null = null;
  private unsubscribeEnded: (() => void) | null = null;
  private waitingForSignIn = false;
  /** The window was closed: nothing more is drawn into it. */
  private closed = false;
  /** The account arrived while a control had focus: the choices are
   *  drawn again once it leaves. */
  private redrawWhenFree = false;
  private makeButton: HTMLButtonElement | null = null;

  private summaryEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  /** The cost, any error, the privacy line and the buttons: pinned to the
   *  bottom of the window, however long the preview above it. */
  private footerEl!: HTMLElement;

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
    this.footerEl = this.contentEl.createDiv({ cls: "synclo-footer" });
    openWindows++;
    this.unsubscribe = this.host.session.onChange((signedIn) => {
      this.waitingForSignIn = false;
      this.error = null;
      this.renderBody();
      if (signedIn) void this.refreshAccount();
    });
    // A sign-in declined or failed: back to Connect.
    this.unsubscribeEnded = this.host.session.onSignInEnded(() => {
      if (!this.waitingForSignIn) return;
      this.waitingForSignIn = false;
      this.renderBody();
    });
    this.scope.register(["Mod"], "Enter", (evt) => {
      evt.preventDefault();
      void this.make();
      return false;
    });
    this.renderSummary();
    this.renderBody();
    void this.rebuild();
    if (this.host.session.isSignedIn()) void this.refreshAccount();
  }

  onClose(): void {
    this.closed = true;
    openWindows = Math.max(0, openWindows - 1);
    this.unsubscribe?.();
    this.unsubscribeEnded?.();
    this.contentEl.empty();
  }

  private async refreshAccount(): Promise<void> {
    await Promise.all([this.host.account(), this.host.themes()]);
    if (this.closed || this.busy || this.drawnFrom === this.accountKey()) return;
    // The cost and balance at once; the choices when no control is in use
    // (an open dropdown would close, a field lose its caret).
    this.renderFooter();
    if (this.controlInUse()) this.waitUntilFree();
    else this.renderBody();
  }

  /** A choice has focus (its dropdown may be open, its field typed in). */
  private controlInUse(): boolean {
    const active = this.contentEl.ownerDocument.activeElement;
    return !!active && this.bodyEl.contains(active) && /^(SELECT|INPUT|TEXTAREA)$/.test(active.tagName);
  }

  private waitUntilFree(): void {
    if (this.redrawWhenFree) return;
    this.redrawWhenFree = true;
    const check = () => {
      // Focus moves after focusout: look once it has landed.
      window.setTimeout(() => {
        if (this.closed || !this.redrawWhenFree) return;
        if (this.controlInUse()) {
          this.bodyEl.addEventListener("focusout", check, { once: true });
          return;
        }
        this.redrawWhenFree = false;
        if (!this.busy) this.renderBody();
      }, 0);
    };
    this.bodyEl.addEventListener("focusout", check, { once: true });
  }

  /** The control that has focus, by name, or null. */
  private focusedControl(): string | null {
    const active = this.contentEl.ownerDocument.activeElement;
    if (!active || !this.contentEl.contains(active)) return null;
    return active.closest(`[${CONTROL}]`)?.getAttribute(CONTROL) ?? null;
  }

  /** Draws again, giving focus back to the control that had it. */
  private keepFocus(draw: () => void): void {
    const name = this.focusedControl();
    draw();
    if (name) this.contentEl.querySelector<HTMLElement>(`[${CONTROL}="${name}"]`)?.focus();
  }

  private accountKey(): string {
    return JSON.stringify([this.host.cachedAccount(), this.host.cachedThemes()?.map((t) => t.id)]);
  }

  private buildSeq = 0;

  private async rebuild(): Promise<void> {
    const seq = ++this.buildSeq;
    const first = seq === 1;
    const run = (async () => {
      this.material = null;
      this.renderSummary();
      // Make waits while the note is read again.
      this.renderFooter();
      const text = this.source.selection ?? (await this.host.app.vault.cachedRead(this.source.file));
      const f = this.source.file;
      const built = await buildMaterial(
        { file: { path: f.path, basename: f.basename, extension: f.extension, size: f.stat.size }, markdown: text, selection: this.source.selection !== undefined, selectionAtStart: this.source.selectionAtStart, before: this.source.before },
        vaultReader(this.host.app),
        { includeLinked: this.choices.includeLinked },
      );
      // A later rebuild (Include linked notes turned again) wins.
      if (seq !== this.buildSeq || this.closed) return;
      this.material = built;
      this.renderSummary();
      this.renderBody();
      // Read: Make is ready for Enter, unless a choice is already in use.
      if (first && !this.focusedControl() && this.makeButton && !this.makeButton.disabled) this.makeButton.focus();
    })();
    this.building = run;
    try {
      await run;
    } catch {
      if (seq !== this.buildSeq || this.closed) return;
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
    if (this.closed) return;
    this.keepFocus(() => this.drawSummary());
  }

  private drawSummary(): void {
    const el = this.summaryEl;
    el.empty();
    const m = this.material;
    // The note by its file name, as the Synclo panel names it.
    const fileName = this.source.file.basename;
    el.createDiv({ cls: "synclo-summary-from", text: this.source.selection !== undefined ? `From the selection in “${fileName}”` : `From “${fileName}”` });
    if (!m) {
      el.createDiv({ cls: "synclo-summary-title", text: this.source.file.basename });
      el.createDiv({ cls: "synclo-summary-line", text: "Reading the note…" });
      return;
    }
    el.createDiv({ cls: "synclo-summary-title", text: m.title });
    const pictures = m.pictures.length + m.remotePictures;
    const parts = [`${m.words.toLocaleString()} ${m.words === 1 ? "word" : "words"}`];
    if (pictures) parts.push(`${pictures} ${pictures === 1 ? "image" : "images"}`);
    if (m.linkedNotes.length) parts.push(`${m.linkedNotes.length} linked ${m.linkedNotes.length === 1 ? "note" : "notes"}`);
    el.createDiv({ cls: "synclo-summary-line", text: parts.join(" · ") });
    if (m.linkedNotes.length) el.createDiv({ cls: "synclo-summary-detail", text: `Linked notes: ${m.linkedNotes.join(", ")}` });
    const left = describeLeftOut(m.leftOut);
    if (left) el.createDiv({ cls: "synclo-summary-detail synclo-left-out", text: `Left out: ${left}` });
    if (m.mostlyLinks) el.createDiv({ cls: "synclo-hint", text: "This note is mostly links. Turn on Include linked notes to send what those notes say." });
    const existing: unknown = this.host.app.metadataCache.getFileCache(this.source.file)?.frontmatter?.synclo;
    if (typeof existing === "string" && /^https?:\/\//.test(existing)) {
      const hint = el.createDiv({ cls: "synclo-hint" });
      hint.createEl("strong", { text: "This note already has a presentation." });
      hint.appendText(" ");
      const open = hint.createEl("a", { text: "Open it", href: existing });
      open.addEventListener("click", (e) => {
        e.preventDefault();
        this.host.openExternal(existing);
      });
      hint.appendText(" · Making a new one links the note to the new one; the first stays in your Synclo library.");
    }
    if (this.mode() === "generate") {
      const pics = m.pictures.length ? " Images in it aren't used." : "";
      el.createDiv({ cls: "synclo-hint", text: `This note is short, so Synclo will treat it as a topic and write the ${unit(this.choices.format, 2)} itself.${pics}` });
    }
    const tooLong = this.tooLong();
    if (tooLong) el.createDiv({ cls: "synclo-warning", text: tooLong });

    const toggle = el.createEl("button", { cls: "synclo-disclosure", attr: { [CONTROL]: "preview" } });
    toggle.toggleClass("is-open", this.previewOpen);
    toggle.setAttribute("aria-expanded", String(this.previewOpen));
    setIcon(toggle.createSpan({ cls: "synclo-disclosure-icon" }), "chevron-right");
    toggle.createSpan({ text: "Preview what's sent" });
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

  /** The choices and the footer, drawn again; the control that had focus
   *  keeps it. */
  private renderBody(): void {
    if (this.closed) return;
    this.redrawWhenFree = false;
    this.keepFocus(() => {
      const el = this.bodyEl;
      el.empty();
      this.drawnFrom = this.accountKey();
      if (!this.host.session.isSignedIn()) {
        this.footerEl.empty();
        this.renderConnect(el, this.footerEl);
        return;
      }
      const choices = el.createDiv({ cls: "synclo-choices" });
      this.renderChoices(choices);
      // Nothing changes while it is being sent.
      if (this.busy) {
        for (const input of choices.findAll("select, input, textarea, button")) input.setAttribute("disabled", "");
      }
      this.drawFooter();
    });
  }

  /** The cost, any error, the privacy line and the buttons only. */
  private renderFooter(): void {
    if (this.closed || !this.host.session.isSignedIn()) return;
    this.keepFocus(() => this.drawFooter());
  }

  private drawFooter(): void {
    const footer = this.footerEl;
    footer.empty();
    this.renderEstimate(footer.createDiv({ cls: "synclo-estimate" }));
    if (this.error) this.renderError(footer.createDiv({ cls: "synclo-error" }));
    footer.createDiv({ cls: "synclo-privacy", text: PRIVACY_LINE });
    this.renderButtons(footer.createDiv({ cls: "synclo-buttons" }));
  }

  private renderConnect(el: HTMLElement, footer: HTMLElement): void {
    this.host.prepareConnect();
    const box = el.createDiv({ cls: "synclo-connect" });
    if (this.waitingForSignIn) {
      box.createDiv({ text: "Finish signing in to Synclo in your browser. This window picks up where you left off when you come back." });
    } else {
      box.createDiv({ text: "Connect your Synclo account to make presentations from your notes. New accounts get 400 free credits." });
    }
    footer.createDiv({ cls: "synclo-privacy", text: PRIVACY_LINE });
    const row = footer.createDiv({ cls: "synclo-buttons" });
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
      named(d.selectEl, "format", d)
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
      named(d.selectEl, "length", d);
      for (const n of options) d.addOption(String(n), `${generate ? "" : "Up to "}${n} ${unit(c.format, n)}`);
      d.setValue(String(c.slides)).onChange((v) => {
        c.slides = Number(v);
        this.renderBody();
      });
    });
    if (account?.slidesPerPrompt) length.setDesc(`Your plan allows up to ${account.slidesPerPrompt} ${unit(c.format, account.slidesPerPrompt)} per ${c.format === "document" ? "document" : "presentation"}.`);

    if (!generate) {
      new Setting(el)
        .setName("Words")
        .setDesc("Tighten the wording and keep every fact, or keep your words exactly as written.")
        .addDropdown((d) =>
          named(d.selectEl, "words", d)
            .addOptions({ condense: "Tighten the wording", preserve: "Keep my exact words" })
            .setValue(c.keepWords ? "preserve" : "condense")
            .onChange((v) => {
              c.keepWords = v === "preserve";
              this.renderBody();
            }),
        );
    }

    const themes = this.host.cachedThemes();
    new Setting(el).setName("Theme").addDropdown((d) => {
      named(d.selectEl, "theme", d);
      d.addOption("", "Designed for this note");
      for (const t of themes ?? []) d.addOption(t.id, t.name);
      if (c.theme && !(themes ?? []).some((t) => t.id === c.theme)) d.addOption(c.theme, "Your saved theme");
      d.setValue(c.theme).onChange((v) => (c.theme = v));
    });

    new Setting(el).setName("Image style").addDropdown((d) => {
      named(d.selectEl, "pictures", d);
      for (const [id, label] of IMAGE_STYLES) d.addOption(id, label);
      d.setValue(IMAGE_STYLES.some(([id]) => id === c.imageStyle) ? c.imageStyle : "theme").onChange((v) => (c.imageStyle = v));
    });

    new Setting(el)
      .setName("Include linked notes")
      .setDesc("Also send the notes it links to directly.")
      .addToggle((t) =>
        named(t.toggleEl, "linked", t)
          .setValue(c.includeLinked)
          .onChange((v) => {
            c.includeLinked = v;
            void this.rebuild();
          }),
      );

    // "More choices": the same disclosure as "Preview the text".
    const toggle = el.createEl("button", { cls: "synclo-disclosure", attr: { [CONTROL]: "more" } });
    setIcon(toggle.createSpan({ cls: "synclo-disclosure-icon" }), "chevron-right");
    toggle.createSpan({ text: "More options" });
    const more = el.createDiv({ cls: "synclo-more" });
    const show = () => {
      toggle.toggleClass("is-open", this.moreOpen);
      toggle.setAttribute("aria-expanded", String(this.moreOpen));
      more.toggle(this.moreOpen);
    };
    show();
    toggle.addEventListener("click", () => {
      this.moreOpen = !this.moreOpen;
      show();
    });
    new Setting(more)
      .setName("Language")
      .setDesc("Leave empty to use the note's language.")
      .addText((t) =>
        named(t.inputEl, "language", t)
          .setPlaceholder("Same as the note")
          .setValue(c.language)
          .onChange((v) => (c.language = v)),
      );
    const instructions = new Setting(more)
      .setName("Instructions")
      .setDesc("Anything Synclo should know, such as who it's for.")
      .addTextArea((t) => {
        named(t.inputEl, "instructions", t);
        t.setPlaceholder("For the board, focus on the results")
          .setValue(c.instructions)
          .onChange((v) => (c.instructions = v));
        t.inputEl.maxLength = 2000;
        t.inputEl.rows = 3;
      });
    // On a phone the field sits under its label, full width.
    instructions.settingEl.addClass("synclo-stacked");
  }

  private credits(): number {
    return this.choices.slides * CREDITS_PER_SLIDE;
  }

  private renderEstimate(el: HTMLElement): void {
    const c = this.choices;
    const balance = this.host.cachedAccount()?.balance ?? null;
    // No price on making (the app's rule): credits show only when they fall
    // short of what this would take.
    if (balance === null || balance >= this.credits()) {
      el.remove();
      return;
    }
    {
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
    if (e.reconnect) {
      this.host.prepareConnect();
      el.createEl("button", { text: "Connect again" }).addEventListener("click", () => {
        this.waitingForSignIn = true;
        void this.host.connect();
      });
    }
  }

  /** Make can't be pressed: the note is being read, it is too long, or it
   *  costs more than the balance. */
  private blocked(): boolean {
    const balance = this.host.cachedAccount()?.balance ?? null;
    return !this.material || !!this.tooLong() || (balance !== null && balance < this.credits());
  }

  private renderButtons(el: HTMLElement): void {
    const make = el.createEl("button", { cls: "mod-cta", text: this.busyText ?? "Make", attr: { [CONTROL]: "make" } });
    make.disabled = this.busy || this.blocked();
    make.addEventListener("click", () => void this.make());
    this.makeButton = make;
    const cancel = el.createEl("button", { text: "Cancel" });
    cancel.disabled = this.busy;
    cancel.addEventListener("click", () => this.close());
  }

  private busyText: string | null = null;
  /** One press of Make, named for Synclo: pressed again with the same
   *  request (after an error), it's the same press; anything changed, or a
   *  new window, is a new press and a new deck. */
  private press: { id: string; request: string } | null = null;

  private pressId(request: Record<string, unknown>): string {
    const key = JSON.stringify(request);
    if (!this.press || this.press.request !== key) this.press = { id: newPressId(), request: key };
    return this.press.id;
  }

  private setBusy(text: string | null): void {
    this.busy = text !== null;
    this.busyText = text;
    this.renderBody();
  }


  private async make(): Promise<void> {
    // Taken at once, before anything is awaited: a second click (or
    // Mod+Enter) finds it busy and starts nothing.
    if (this.busy || this.closed || !this.host.session.isSignedIn()) return;
    this.busy = true;
    this.busyText = null;
    this.renderBody();
    if (this.building) await this.building.catch(() => undefined);
    const m = this.material;
    if (this.closed || !m || this.blocked()) {
      this.busy = false;
      this.renderBody();
      return;
    }
    this.error = null;
    const c = this.choices;
    const mode = this.mode();
    /** create_presentation was asked: from here on, it carries on even if
     *  the window is closed. */
    let asked = false;
    try {
      // The note's own pictures go first, only now that Make was clicked.
      const urls = new Map<number, string>();
      let skipped = 0;
      if (mode !== "generate" && m.pictures.length) {
        for (const [i, pic] of m.pictures.entries()) {
          this.setBusy(`Sending images (${i + 1} of ${m.pictures.length})…`);
          const file = this.host.app.vault.getFileByPath(pic.file.path);
          if (!file) {
            skipped++;
            continue;
          }
          try {
            urls.set(pic.n, await this.host.uploadPicture(file, pic.type));
          } catch (err) {
            if (err instanceof SyncloError && err.kind === "rejected") skipped++;
            else if (err instanceof SyncloError && err.kind === "rate-limited") {
              skipped += m.pictures.length - i;
              break;
            } else throw err;
          }
          // Closed while the pictures were sent: nothing is made.
          if (this.closed) return;
        }
      }
      if (this.closed) return;
      const input = mode === "generate" ? withPictures(m, new Map()) : withPictures(m, urls);
      if (input.length > LIMITS.maxInputChars) throw new SyncloError("too-large", "With its images this is too long to send in one go. Make a presentation from a selection instead.");
      this.setBusy("Starting…");
      asked = true;
      const request = {
        input,
        mode,
        format: c.format,
        slides: c.slides,
        theme: c.theme || undefined,
        image_style: c.imageStyle && c.imageStyle !== "theme" ? c.imageStyle : undefined,
        language: c.language || undefined,
        instructions: c.instructions || undefined,
      };
      const started = await this.host.api.create({ ...request, request_id: this.pressId(request) });
      const already = this.host.runner.list().some((j) => j.generationId === started.generationId);
      this.host.startJob({ generationId: started.generationId, notePath: this.source.file.path, title: m.title, format: c.format, base: this.host.base(), startedAt: Date.now() });
      this.busy = false;
      this.close();
      if (already) this.host.runner.kick();
      if (skipped) new Notice(`${skipped} of the note's images couldn't be sent, so Synclo is making it without them.`);
    } catch (err) {
      this.busy = false;
      this.busyText = null;
      if (isOutOfCredits(err)) void this.host.account(true);
      if (this.closed) {
        // The window is gone; what was asked still answers, in a notice.
        if (asked) {
          richNotice({
            title: `Synclo couldn't make “${m.title || "Untitled"}”`,
            line: messageFor(err),
            actions: isOutOfCredits(err) ? [{ label: "Get more credits", primary: true, run: () => this.host.openExternal(this.host.creditsUrl()) }] : [],
          });
        }
        return;
      }
      this.error = {
        message: messageFor(err),
        outOfCredits: isOutOfCredits(err),
        reconnect: err instanceof SyncloError && (err.kind === "signed-out" || err.code === "forbidden" || err.code === "insufficient_scope"),
      };
      this.renderBody();
    } finally {
      if (this.closed) this.busy = false;
    }
  }
}

/** Names a control (for focus to come back to it after a redraw) and
 *  returns its component, for chaining. */
function named<T>(el: HTMLElement, name: string, component: T): T {
  el.setAttribute(CONTROL, name);
  return component;
}

/** 32 random letters and digits (crypto.randomUUID isn't on every phone). */
function newPressId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
