import { ItemView, setIcon, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import type { SyncloHost } from "../host";
import { progressInputOf, progressWords, unit, type PendingJob } from "../jobs/jobs";
import { cardProgressInput, imageKey } from "../panel/model";
import { clampSlide, deckStateOf, deckStateRecord, fitBox, keyStep, swipeStep, type Size } from "../panel/viewer";
import type { DeckWatch } from "../panel/watch";
import { noteNameOf } from "./panel-view";
import { capital, finalOf, onScreen, presentationOf } from "./views";

export const DECK_VIEW = "synclo-deck";

interface Thumb {
  el: HTMLElement;
  img: HTMLImageElement;
  sketch: HTMLElement;
  no: HTMLElement;
  title: HTMLElement;
}

interface Els {
  actions: HTMLElement;
  stage: HTMLElement;
  room: HTMLElement;
  slide: HTMLElement;
  sketch: HTMLElement;
  sketchNo: HTMLElement;
  sketchTitle: HTMLElement;
  pic: HTMLImageElement;
  prev: HTMLButtonElement;
  next: HTMLButtonElement;
  msg: HTMLElement;
  msgText: HTMLElement;
  cap: HTMLElement;
  note: HTMLElement;
  noteText: HTMLElement;
  fix: HTMLButtonElement;
  thumbs: HTMLElement;
  thumbList: Thumb[];
}

/** Whether a picture element shows its picture now. */
const drawn = (img: HTMLImageElement) => img.complete && img.naturalWidth > 0;

/**
 * The deck viewer: a finished deck's slides, large, in a tab of their own.
 * The slide as large as fits (in its own shape, never cropped, never past
 * its picture's size), the caption under it, every slide below to jump
 * to, and Open in Synclo with the downloads above. Keys and swipes step
 * through it. What it shows comes from the plugin's watch on the deck,
 * shared with the Synclo panel; the tab remembers the deck and the slide.
 */
export class SyncloDeckView extends ItemView {
  private job: PendingJob | null = null;
  private at = 0;
  private watch: DeckWatch | null = null;
  private unwatch: (() => void) | null = null;
  private els: Els | null = null;
  /** The shown picture's own size, and the largest seen in this deck. */
  private natural: Size | null = null;
  private cap: Size | null = null;
  private fixRun: (() => void) | null = null;
  private connectReady = false;
  private headerTitle: string | null = null;
  private touch: { x: number; y: number } | null = null;
  private observer: ResizeObserver | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly host: SyncloHost,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return DECK_VIEW;
  }

  getDisplayText(): string {
    return this.title();
  }

  getIcon(): string {
    return "presentation";
  }

  getState(): Record<string, unknown> {
    return this.job ? deckStateRecord({ job: { ...this.job, title: this.title() }, slide: this.at }) : {};
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const kept = deckStateOf(state);
    if (kept) this.show(kept.job, kept.slide);
    await super.setState(state, result);
  }

  async onOpen(): Promise<void> {
    this.build();
    // Asked only while it can be seen: again as soon as it can (in a
    // window of its own, that window's document says).
    this.registerDomEvent(this.containerEl.doc, "visibilitychange", () => this.wake());
    this.registerEvent(this.app.workspace.on("layout-change", () => this.wake()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.wake()));
    this.register(
      this.host.progressBoard.onChange((id) => {
        if (id === this.job?.generationId) this.render();
      }),
    );
    this.registerDomEvent(this.contentEl, "keydown", (evt) => this.onKey(evt));
    this.render();
    this.scrollToCurrent(false);
  }

  async onClose(): Promise<void> {
    this.observer?.disconnect();
    this.observer = null;
    this.unwatch?.();
    this.unwatch = null;
    this.watch = null;
  }

  onResize(): void {
    this.fit();
    this.wake();
  }

  /** Puts the keyboard on the viewer, so the keys step through it. */
  focusSlides(): void {
    this.contentEl.focus({ preventScroll: true });
  }

  private wake(): void {
    this.watch?.wake();
  }

  /** Shows a deck at a slide; the same deck only goes to the slide. */
  private show(job: PendingJob, slide: number): void {
    const same = this.job?.generationId === job.generationId;
    this.job = job;
    this.at = Math.max(0, slide);
    if (!same) {
      this.unwatch?.();
      this.natural = null;
      this.cap = null;
      const watch = this.host.deckWatch(job);
      this.watch = watch;
      this.unwatch = watch.subscribe({ changed: () => this.render(), visible: () => onScreen(this.app, this) });
    }
    this.render();
    this.scrollToCurrent(false);
  }

  /** The deck's title (Synclo's once known), else the note's name. */
  private title(): string {
    const w = this.watch;
    const job = this.job;
    return presentationOf(w)?.title || w?.card?.title || job?.title || (job ? noteNameOf(job.notePath) : "") || "Synclo";
  }

  /* ── Drawing ─────────────────────────────────────────────────────────── */

  private build(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("synclo-deck");
    root.setAttribute("tabindex", "-1");

    const actions = root.createDiv({ cls: "synclo-deck-actions" });
    const open = actions.createEl("button", { cls: "mod-cta", text: "Open in Synclo" });
    const pptx = actions.createEl("button", { text: "Download PowerPoint" });
    const pdf = actions.createEl("button", { text: "Download PDF" });
    open.addEventListener("click", () => {
      const doc = presentationOf(this.watch);
      if (doc) this.host.openExternal(doc.editUrl);
    });
    pptx.addEventListener("click", () => this.download("pptx"));
    pdf.addEventListener("click", () => this.download("pdf"));

    const stage = root.createDiv({ cls: "synclo-deck-stage" });
    const room = stage.createDiv({ cls: "synclo-deck-room" });
    const slide = room.createDiv({ cls: "synclo-deck-slide" });
    const sketch = slide.createDiv({ cls: "synclo-sketch" });
    const sketchNo = sketch.createDiv({ cls: "synclo-sketch-no" });
    const sketchTitle = sketch.createDiv({ cls: "synclo-sketch-title" });
    const pic = slide.createEl("img", { cls: "synclo-deck-pic", attr: { alt: "" } });
    pic.addEventListener("load", () => this.pictureLoaded());
    pic.addEventListener("error", () => this.retry(pic));
    const prev = slide.createEl("button", { cls: "synclo-deck-nav is-prev", attr: { type: "button" } });
    setIcon(prev, "chevron-left");
    const next = slide.createEl("button", { cls: "synclo-deck-nav is-next", attr: { type: "button" } });
    setIcon(next, "chevron-right");
    prev.addEventListener("click", () => this.go(this.at - 1));
    next.addEventListener("click", () => this.go(this.at + 1));
    const msg = room.createDiv({ cls: "synclo-deck-msg" });
    const msgText = msg.createSpan();
    msg.createDiv({ cls: "synclo-shimmer" });

    // A sideways swipe steps through the deck.
    this.registerDomEvent(
      stage,
      "touchstart",
      (evt) => {
        const t = evt.touches[0];
        this.touch = evt.touches.length === 1 && t ? { x: t.clientX, y: t.clientY } : null;
      },
      { passive: true },
    );
    this.registerDomEvent(
      stage,
      "touchend",
      (evt) => {
        const start = this.touch;
        const t = evt.changedTouches[0];
        this.touch = null;
        if (!start || !t) return;
        const by = swipeStep(t.clientX - start.x, t.clientY - start.y);
        if (by) this.go(this.at + by);
      },
      { passive: true },
    );

    const cap = root.createDiv({ cls: "synclo-deck-cap" });
    const note = root.createDiv({ cls: "synclo-deck-note" });
    const noteText = note.createDiv();
    const fix = note.createEl("button", { cls: "mod-cta" });
    fix.addEventListener("click", () => this.fixRun?.());
    const thumbs = root.createDiv({ cls: "synclo-deck-thumbs" });

    this.els = { actions, stage, room, slide, sketch, sketchNo, sketchTitle, pic, prev, next, msg, msgText, cap, note, noteText, fix, thumbs, thumbList: [] };

    // The slide is sized to the room it has, whenever that changes.
    this.observer = new ResizeObserver(() => this.fit());
    this.observer.observe(room);
  }

  private download(format: "pptx" | "pdf"): void {
    const doc = presentationOf(this.watch);
    if (!doc || !this.job) return;
    const note = this.app.vault.getFileByPath(this.job.notePath);
    void this.host.download(doc.id, format, note, doc.title);
  }

  /** Goes to a slide (stopping at the ends). */
  private go(index: number): void {
    const count = this.watch?.slides.length ?? 0;
    const next = clampSlide(index, count);
    if (next === this.at) return;
    this.at = next;
    this.render();
    // An arrow that ends up disabled at the deck's end hands the keys back
    // to the viewer.
    const e = this.els;
    const active = this.containerEl.doc.activeElement;
    if (e && ((active === e.prev && e.prev.disabled) || (active === e.next && e.next.disabled))) this.focusSlides();
    this.scrollToCurrent(true);
    // The tab remembers the slide across a restart.
    this.app.workspace.requestSaveLayout();
  }

  private onKey(evt: KeyboardEvent): void {
    if (evt.defaultPrevented || evt.altKey || evt.ctrlKey || evt.metaKey) return;
    const next = keyStep(evt.key, this.at, this.watch?.slides.length ?? 0);
    if (next === null) return;
    evt.preventDefault();
    this.go(next);
  }

  /** The current slide's thumbnail brought into view. */
  private scrollToCurrent(animate: boolean): void {
    const thumb = this.els?.thumbList[this.at];
    if (!thumb) return;
    const still = this.containerEl.win.matchMedia("(prefers-reduced-motion: reduce)").matches;
    thumb.el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: animate && !still ? "smooth" : "auto" });
  }

  /** Sizes the slide to the room it has. */
  private fit(): void {
    const e = this.els;
    if (!e) return;
    const box = fitBox({ w: e.room.clientWidth, h: e.room.clientHeight }, this.natural, this.cap);
    e.slide.setCssProps({ "--synclo-deck-w": `${box.w}px`, "--synclo-deck-h": `${box.h}px` });
  }

  private pictureLoaded(): void {
    const e = this.els;
    if (!e || !drawn(e.pic)) return;
    e.pic.addClass("is-on");
    e.sketch.hide();
    const size = { w: e.pic.naturalWidth, h: e.pic.naturalHeight };
    this.natural = size;
    if (!this.cap || size.w > this.cap.w) this.cap = size;
    this.fit();
  }

  /** An address past its hour: the latest one for the same picture. */
  private retry(img: HTMLImageElement): void {
    const src = img.getAttribute("src");
    const latest = src ? this.watch?.fresher(src) : null;
    if (latest) img.setAttribute("src", latest);
  }

  private render(): void {
    const e = this.els;
    const job = this.job;
    if (!e || !job) return;
    const w = this.watch;
    const card = w?.card ?? null;
    const slides = w?.slides ?? [];
    const format = card?.format ?? job.format;
    const one = capital(unit(format, 1));
    const progress = this.host.progressBoard.get(job.generationId) ?? (card ? cardProgressInput(card) : progressInputOf(null));
    const final = finalOf(this.host, w);
    const doc = presentationOf(w);
    const done = card?.status === "completed" || progress.status === "completed";
    // Kept as it is until the slides are known (a tab restored before
    // Synclo has answered keeps its slide).
    if (slides.length) this.at = clampSlide(this.at, slides.length);

    // The deck's own colors on its sketches, once Synclo has chosen them.
    this.contentEl.setCssProps({
      "--synclo-sketch-bg": card?.colors?.slide ?? "",
      "--synclo-sketch-ink": card?.colors?.heading ?? "",
    });
    this.contentEl.toggleClass("has-colors", !!card?.colors);
    // A document's sections are shown whole.
    this.contentEl.toggleClass("is-document", format === "document");

    e.actions.toggle(done && !!doc);

    const gone = !!final?.gone;
    const shown = gone ? undefined : slides[this.at];
    const caption = shown ? `${one} ${this.at + 1} · ${shown.title}` : "";
    e.slide.toggle(!!shown);
    // Before the plan: where it stands, as the panel says it.
    e.msg.toggle(!shown && !final);
    e.msgText.setText(done ? "" : progressWords(progress, format, noteNameOf(job.notePath), false).line);

    if (shown) {
      e.sketchNo.setText(String(this.at + 1).padStart(2, "0"));
      e.sketchTitle.setText(shown.title);
      this.showPicture(w?.address(shown.image) ?? null, caption);
    }
    e.cap.setText(caption);
    e.cap.toggle(!!shown);

    const many = !gone && slides.length > 1;
    e.prev.toggle(many);
    e.next.toggle(many);
    e.prev.disabled = this.at <= 0;
    e.next.disabled = this.at >= slides.length - 1;
    e.prev.setAttribute("aria-label", `Previous ${unit(format, 1)}`);
    e.next.setAttribute("aria-label", `Next ${unit(format, 1)}`);

    // Why there is no more to follow, and what to do about it.
    if (final?.connect && !this.connectReady) this.host.prepareConnect();
    this.connectReady = !!final?.connect;
    e.note.toggle(!!final);
    e.noteText.setText(final?.message ?? "");
    this.fixRun = final?.action?.run ?? null;
    e.fix.setText(final?.action?.label ?? "");
    e.fix.toggle(!!final?.action);

    this.renderThumbs(gone ? [] : slides, one);
    this.fit();

    // The tab's name follows the deck's title.
    const title = this.title();
    if (this.headerTitle !== null && this.headerTitle !== title) (this.leaf as WorkspaceLeaf & { updateHeader?: () => void }).updateHeader?.();
    this.headerTitle = title;
  }

  /** Shows a picture in the large slide: its sketch until it has loaded;
   *  the same picture under a fresh signature is never loaded again. */
  private showPicture(address: string | null, caption: string): void {
    const e = this.els;
    if (!e) return;
    const pic = e.pic;
    pic.setAttribute("alt", caption);
    const current = pic.getAttribute("src");
    if (!address) {
      pic.removeAttribute("src");
      pic.removeClass("is-on");
    } else if (!current || imageKey(current) !== imageKey(address)) {
      pic.removeClass("is-on");
      pic.setAttribute("src", address);
      // Already loaded once (a thumbnail did): shown at once.
      if (drawn(pic)) this.pictureLoaded();
    }
    e.sketch.toggle(!pic.hasClass("is-on"));
  }

  private renderThumbs(slides: Array<{ title: string; image: string | null }>, one: string): void {
    const e = this.els;
    if (!e) return;
    e.thumbs.toggle(slides.length > 1);
    const list = e.thumbList;
    const added = list.length < slides.length;
    while (list.length < slides.length) list.push(this.thumb(e.thumbs, list.length));
    while (list.length > slides.length) list.pop()?.el.remove();
    slides.forEach((s, i) => {
      const t = list[i];
      if (!t) return;
      const caption = `${one} ${i + 1} · ${s.title}`;
      t.el.setAttribute("aria-label", caption);
      t.img.setAttribute("alt", caption);
      const current = i === this.at;
      t.el.toggleClass("is-current", current);
      if (current) t.el.setAttribute("aria-current", "true");
      else t.el.removeAttribute("aria-current");
      t.no.setText(String(i + 1).padStart(2, "0"));
      t.title.setText(s.title);
      const address = this.watch?.address(s.image) ?? null;
      const src = t.img.getAttribute("src");
      if (!address) {
        t.img.removeAttribute("src");
        t.img.removeClass("is-on");
      } else if (!src || imageKey(src) !== imageKey(address)) {
        t.img.removeClass("is-on");
        t.img.setAttribute("src", address);
        if (drawn(t.img)) t.img.addClass("is-on");
      }
      t.sketch.toggle(!t.img.hasClass("is-on"));
    });
    // The deck's slides just arrived: the current one in view.
    if (added) this.scrollToCurrent(false);
  }

  private thumb(parent: HTMLElement, i: number): Thumb {
    const el = parent.createDiv({ cls: "synclo-deck-thumb", attr: { role: "button", tabindex: "0" } });
    const sketch = el.createDiv({ cls: "synclo-sketch" });
    const no = sketch.createDiv({ cls: "synclo-sketch-no" });
    const title = sketch.createDiv({ cls: "synclo-sketch-title" });
    const img = el.createEl("img", { cls: "synclo-deck-pic", attr: { alt: "" } });
    img.addEventListener("load", () => {
      if (!drawn(img)) return;
      img.addClass("is-on");
      sketch.hide();
    });
    img.addEventListener("error", () => this.retry(img));
    el.addEventListener("click", () => this.go(i));
    el.addEventListener("keydown", (evt) => {
      if (evt.key !== "Enter" && evt.key !== " ") return;
      evt.preventDefault();
      this.go(i);
    });
    return { el, img, sketch, no, title };
  }
}
