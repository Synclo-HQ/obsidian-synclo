import { ItemView, setIcon, type WorkspaceLeaf } from "obsidian";
import type { SyncloHost } from "../host";
import { progressInputOf, progressWords, unit, type PendingJob } from "../jobs/jobs";
import { cardProgressInput, heroSlide, imageKey, shareOf } from "../panel/model";
import type { DeckWatch, RunnerDocument } from "../panel/watch";
import { capital, finalOf, onScreen, presentationOf } from "./views";

export const PANEL_VIEW = "synclo-panel";

/** A note's name, from its path. */
export function noteNameOf(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.md$/i, "");
}

/** Two stacked pictures, so one fades into the next, over the slide's
 *  sketch, which stays until a picture has loaded. */
interface Fader {
  a: HTMLImageElement;
  b: HTMLImageElement;
  /** The address wanted. */
  shown: string | null;
  /** The picture loading it. */
  loading: HTMLImageElement | null;
  sketch: HTMLElement;
  /** The sketch is wanted while no picture is on. */
  wantSketch: boolean;
}

interface Frame {
  el: HTMLElement;
  fader: Fader;
  sketchNo: HTMLElement;
  sketchTitle: HTMLElement;
}

interface Parts {
  from: HTMLElement;
  title: HTMLElement;
  status: HTMLElement;
  bar: HTMLElement;
  hero: HTMLElement;
  /** The large slide as the way into the deck viewer (over the picture,
   *  under the arrows). */
  opener: HTMLElement;
  heroFader: Fader;
  heroNo: HTMLElement;
  heroTitle: HTMLElement;
  heroMsg: HTMLElement;
  prev: HTMLButtonElement;
  next: HTMLButtonElement;
  cap: HTMLElement;
  fix: HTMLButtonElement;
  actions: HTMLElement;
  meta: HTMLElement;
  grid: HTMLElement;
  frames: Frame[];
}

/**
 * The Synclo panel: the deck being made, as it arrives. The plan, then
 * each slide as it is written (the slide that changed last, large), then
 * its images; once ready, the whole deck to look through, with Open and
 * the downloads. It only shows: the job runner writes the link into the
 * note and says when it is ready or failed. What it shows comes from the
 * plugin's watch on the deck, shared by every panel showing it.
 */
export class SyncloPanelView extends ItemView {
  private target: PendingJob | null = null;
  private watch: DeckWatch | null = null;
  private unwatch: (() => void) | null = null;
  private picked: number | null = null;
  private parts: Parts | null = null;
  /** The deck drawn as ready, with its actions; null otherwise. */
  private drawnReady: string | null = null;
  /** The deck is finished (as last drawn). */
  private finished = false;
  /** The slide the large frame shows (as last drawn). */
  private heroAt: number | null = null;
  private fixRun: (() => void) | null = null;
  /** A sign-in was got ready for the Connect shown. */
  private connectReady = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly host: SyncloHost,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return PANEL_VIEW;
  }

  getDisplayText(): string {
    return "Synclo";
  }

  getIcon(): string {
    return "presentation";
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("synclo-panel");
    // Asked only while it can be seen: again as soon as it can (in a
    // window of its own, that window's document says).
    this.registerDomEvent(this.containerEl.doc, "visibilitychange", () => this.wake());
    this.registerEvent(this.app.workspace.on("layout-change", () => this.wake()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.wake()));
    this.registerEvent(this.app.workspace.on("resize", () => this.wake()));
    // Where it stands follows the newest answer, the job runner's too.
    this.register(
      this.host.progressBoard.onChange((id) => {
        if (id === this.target?.generationId) this.render();
      }),
    );
    // The link line follows the note's properties.
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (file.path === this.target?.notePath) this.render();
      }),
    );
    this.show(this.host.panelTarget());
  }

  async onClose(): Promise<void> {
    this.unwatch?.();
    this.unwatch = null;
    this.watch = null;
  }

  onResize(): void {
    this.wake();
  }

  /** Asks Synclo again now, if the panel is following a deck. */
  wake(): void {
    this.watch?.wake();
  }

  /** On screen: its window in front, the panel not behind another tab, its
   *  sidebar not collapsed, its drawer not closed. */
  visible(): boolean {
    return onScreen(this.app, this);
  }

  /** On screen, showing this deck as ready with its actions. */
  showsReady(generationId: string): boolean {
    return this.drawnReady === generationId && this.target?.generationId === generationId && this.visible();
  }

  /** Shows a deck: a new Make starts it from the beginning; the same deck
   *  only asks again. */
  show(target: PendingJob | null): void {
    if (target && this.parts && this.target?.generationId === target.generationId) {
      this.target = target;
      this.render();
      this.wake();
      return;
    }
    this.unwatch?.();
    this.unwatch = null;
    this.watch = null;
    this.target = target;
    this.picked = null;
    this.drawnReady = null;
    this.build();
    if (!target) return;
    const watch = this.host.deckWatch(target);
    this.watch = watch;
    this.unwatch = watch.subscribe({ changed: () => this.render(), visible: () => this.visible() });
    this.render();
  }

  /* ── Drawing ─────────────────────────────────────────────────────────── */

  private build(): void {
    const root = this.contentEl;
    root.empty();
    this.parts = null;
    if (!this.target) {
      // Nothing made from this vault yet: the way to make one.
      const empty = root.createDiv({ cls: "synclo-panel-empty" });
      const make = empty.createEl("button", { cls: "mod-cta", text: "Make a presentation from this note" });
      make.addEventListener("click", () => this.host.makeFromActiveNote());
      return;
    }
    const body = root.createDiv({ cls: "synclo-panel-body" });
    const from = body.createDiv({ cls: "synclo-panel-from" });
    const title = body.createDiv({ cls: "synclo-panel-title" });
    const status = body.createDiv({ cls: "synclo-panel-status", attr: { "aria-live": "polite" } });
    const bar = body.createDiv({ cls: "synclo-panel-bar" });
    bar.createEl("i");

    const hero = body.createDiv({ cls: "synclo-panel-hero" });
    const heroSketch = hero.createDiv({ cls: "synclo-sketch" });
    const heroNo = heroSketch.createDiv({ cls: "synclo-sketch-no" });
    const heroTitle = heroSketch.createDiv({ cls: "synclo-sketch-title" });
    const heroFader = this.fader(hero, heroSketch);
    const heroMsg = hero.createDiv({ cls: "synclo-panel-msg" });
    const opener = hero.createDiv({ cls: "synclo-panel-open" });
    const prev = hero.createEl("button", { cls: "synclo-panel-nav is-prev", attr: { type: "button" } });
    setIcon(prev, "chevron-left");
    const next = hero.createEl("button", { cls: "synclo-panel-nav is-next", attr: { type: "button" } });
    setIcon(next, "chevron-right");
    prev.addEventListener("click", (evt) => {
      evt.stopPropagation();
      this.step(-1);
    });
    next.addEventListener("click", (evt) => {
      evt.stopPropagation();
      this.step(1);
    });
    // The large slide opens the deck viewer at that slide.
    opener.addEventListener("click", () => this.openViewer());
    opener.addEventListener("keydown", (evt) => {
      if (evt.key !== "Enter" && evt.key !== " ") return;
      evt.preventDefault();
      this.openViewer();
    });

    const cap = body.createDiv({ cls: "synclo-panel-cap" });
    const fix = body.createEl("button", { cls: "mod-cta synclo-panel-fix" });
    fix.addEventListener("click", () => this.fixRun?.());
    const actions = body.createDiv({ cls: "synclo-panel-actions" });
    const open = actions.createEl("button", { cls: "mod-cta", text: "Open in Synclo" });
    const pptx = actions.createEl("button", { text: "Download PowerPoint" });
    const pdf = actions.createEl("button", { text: "Download PDF" });
    open.addEventListener("click", () => {
      const doc = this.presentation();
      if (doc) this.host.openExternal(doc.editUrl);
    });
    pptx.addEventListener("click", () => this.download("pptx"));
    pdf.addEventListener("click", () => this.download("pdf"));
    const meta = body.createDiv({ cls: "synclo-panel-meta" });
    const grid = body.createDiv({ cls: "synclo-panel-grid" });

    this.parts = { from, title, status, bar, hero, opener, heroFader, heroNo, heroTitle, heroMsg, prev, next, cap, fix, actions, meta, grid, frames: [] };
    this.render();
  }

  private fader(parent: HTMLElement, sketch: HTMLElement): Fader {
    const a = parent.createEl("img", { cls: "synclo-fade", attr: { alt: "" } });
    const b = parent.createEl("img", { cls: "synclo-fade", attr: { alt: "" } });
    const f: Fader = { a, b, shown: null, loading: null, sketch, wantSketch: false };
    for (const img of [a, b]) {
      const other = img === a ? b : a;
      // Shown once it has loaded (the sketch stays until then).
      img.addEventListener("load", () => {
        if (f.loading !== img) return;
        f.loading = null;
        img.addClass("is-on");
        other.removeClass("is-on");
        this.syncSketch(f);
      });
      // An address past its hour: the latest one for the same picture.
      img.addEventListener("error", () => {
        const src = img.getAttribute("src");
        const latest = src ? this.watch?.fresher(src) : null;
        if (!src || !latest) return;
        if (f.shown === src) f.shown = latest;
        img.setAttribute("src", latest);
      });
    }
    return f;
  }

  /** Shows `address` in a fader, fading from what it showed once it has
   *  loaded. */
  private fade(f: Fader, address: string | null): void {
    if (f.shown !== address) {
      // The same picture already on screen under a fresh signature is kept,
      // never loaded again.
      const same = !!address && !!f.shown && !f.loading && imageKey(address) === imageKey(f.shown) && (f.a.hasClass("is-on") || f.b.hasClass("is-on"));
      f.shown = address;
      if (!address) {
        f.loading = null;
        f.a.removeClass("is-on");
        f.b.removeClass("is-on");
      } else if (!same) {
        const off = f.a.hasClass("is-on") ? f.b : f.a;
        f.loading = off;
        off.setAttribute("src", address);
      }
    }
    this.syncSketch(f);
  }

  private syncSketch(f: Fader): void {
    f.sketch.toggle(f.wantSketch && !(f.a.hasClass("is-on") || f.b.hasClass("is-on")));
  }

  private step(by: number): void {
    const slides = this.watch?.slides ?? [];
    const n = slides.length;
    if (!n) return;
    const at = heroSlide(slides, this.watch?.lastChanged ?? null, this.picked, true) ?? 0;
    this.picked = (at + by + n) % n;
    this.render();
  }

  private presentation(): RunnerDocument | null {
    return presentationOf(this.watch);
  }

  private openViewer(): void {
    if (!this.target || this.heroAt === null) return;
    void this.host.openDeck(this.target, this.heroAt);
  }

  private download(format: "pptx" | "pdf"): void {
    const doc = this.presentation();
    if (!doc || !this.target) return;
    const note = this.app.vault.getFileByPath(this.target.notePath);
    void this.host.download(doc.id, format, note, doc.title);
  }

  private render(): void {
    const p = this.parts;
    const target = this.target;
    if (!p || !target) return;
    const w = this.watch;
    const card = w?.card ?? null;
    const slides = w?.slides ?? [];
    const name = noteNameOf(target.notePath);
    const format = card?.format ?? target.format;
    const one = capital(unit(format, 1));

    // Where it stands: the newest answer, this panel's or the job runner's
    // (the status bar reads the same).
    const progress = this.host.progressBoard.get(target.generationId) ?? (card ? cardProgressInput(card) : progressInputOf(null));
    const words = progressWords(progress, format, name, false);
    const final = finalOf(this.host, w);
    const doc = this.presentation();
    // Finished when either answer says so.
    const done = card?.status === "completed" || progress.status === "completed";
    this.finished = done;

    // The deck's own colors on its sketches, once Synclo has chosen them.
    this.contentEl.setCssProps({
      "--synclo-sketch-bg": card?.colors?.slide ?? "",
      "--synclo-sketch-ink": card?.colors?.heading ?? "",
    });
    this.contentEl.toggleClass("has-colors", !!card?.colors);
    // A document's sections are shown whole, not cropped to a slide.
    this.contentEl.toggleClass("is-document", format === "document");

    p.from.setText(`From “${name}”`);
    const named = !!card && (card.frames.length > 0 || !!card.document);
    p.title.setText(named ? (card?.title ?? card?.document?.title ?? name) : (w?.runnerDocument?.title ?? name));

    const statusLine = final ? final.message : done ? "" : words.line;
    p.status.setText(statusLine);
    p.status.toggle(!!statusLine);

    const share = shareOf(progress);
    p.bar.toggle(!done && !final);
    p.bar.toggleClass("is-waiting", share === null);
    p.bar.setCssProps({ "--synclo-progress": share === null ? "" : `${Math.round(share * 100)}%` });

    // The large frame: the slide that changed last (or the one picked).
    const at = heroSlide(slides, w?.lastChanged ?? null, this.picked, done);
    const shown = at !== null ? slides[at] : undefined;
    p.heroFader.wantSketch = !!shown;
    this.fade(p.heroFader, w?.address(shown?.image ?? null) ?? null);
    if (shown) {
      p.heroNo.setText(String((at ?? 0) + 1).padStart(2, "0"));
      p.heroTitle.setText(shown.title);
    }
    // Before the plan: where it stands, in the frame (or why it ended).
    p.heroMsg.empty();
    p.heroMsg.toggle(!slides.length);
    if (!slides.length) {
      p.heroMsg.createSpan({ text: final ? final.message : done ? "" : words.line });
      if (!final && !done) p.heroMsg.createDiv({ cls: "synclo-shimmer" });
    }
    p.prev.setAttribute("aria-label", `Previous ${unit(format, 1)}`);
    p.next.setAttribute("aria-label", `Next ${unit(format, 1)}`);
    p.prev.toggle(done && slides.length > 1);
    p.next.toggle(done && slides.length > 1);
    const caption = shown ? `${one} ${(at ?? 0) + 1} · ${shown.title}` : "";
    p.cap.setText(caption);
    // The large slide is the way into the deck viewer.
    this.heroAt = shown ? (at ?? 0) : null;
    p.opener.toggle(!!shown);
    if (shown) {
      p.opener.setAttribute("role", "button");
      p.opener.setAttribute("tabindex", "0");
      p.opener.setAttribute("aria-label", caption);
    } else {
      for (const attr of ["role", "tabindex", "aria-label"]) p.opener.removeAttribute(attr);
    }

    // A Connect shown opens the sign-in in the same moment as the click.
    if (final?.connect && !this.connectReady) this.host.prepareConnect();
    this.connectReady = !!final?.connect;
    this.fixRun = final?.action?.run ?? null;
    p.fix.setText(final?.action?.label ?? "");
    p.fix.toggle(!!final?.action);

    const showActions = done && !!doc;
    p.actions.toggle(showActions);
    this.drawnReady = showActions ? target.generationId : null;
    const count = doc?.slides || slides.length;
    const note = this.app.vault.getFileByPath(target.notePath);
    const linked = !!doc && !!note && this.host.noteDocumentId(note) === doc.id;
    p.meta.toggle(showActions && count > 0);
    p.meta.setText(`${count} ${unit(format, count)}.${linked ? " The link is in the note's properties." : ""}`);

    // Every slide: its sketch until it is drawn, then its picture.
    p.grid.toggle(slides.length > 0);
    while (p.frames.length < slides.length) p.frames.push(this.frame(p.grid, p.frames.length));
    while (p.frames.length > slides.length) p.frames.pop()?.el.remove();
    slides.forEach((s, i) => {
      const f = p.frames[i];
      if (!f) return;
      const pic = w?.address(s.image) ?? null;
      f.fader.wantSketch = true;
      this.fade(f.fader, pic);
      f.el.toggleClass("has-picture", !!pic);
      const selected = !!pic && i === at && (done || this.picked !== null);
      // A drawn slide can be picked, by pointer or by keyboard.
      if (pic) {
        f.el.setAttribute("role", "button");
        f.el.setAttribute("tabindex", "0");
        f.el.setAttribute("aria-label", `${one} ${i + 1}: ${s.title}`);
        f.el.setAttribute("aria-pressed", String(selected));
      } else {
        for (const attr of ["role", "tabindex", "aria-label", "aria-pressed"]) f.el.removeAttribute(attr);
      }
      f.el.toggleClass("is-selected", selected);
      f.sketchNo.setText(String(i + 1).padStart(2, "0"));
      f.sketchTitle.setText(s.title);
    });
  }

  private frame(grid: HTMLElement, i: number): Frame {
    const el = grid.createDiv({ cls: "synclo-panel-frame" });
    const sketch = el.createDiv({ cls: "synclo-sketch" });
    const sketchNo = sketch.createDiv({ cls: "synclo-sketch-no" });
    const sketchTitle = sketch.createDiv({ cls: "synclo-sketch-title" });
    const fader = this.fader(el, sketch);
    const pick = () => {
      if (!el.hasClass("has-picture")) return;
      // While it is made, the latest slide picked again follows it live.
      this.picked = !this.finished && i === this.watch?.lastChanged ? null : i;
      this.render();
    };
    el.addEventListener("click", pick);
    el.addEventListener("keydown", (evt) => {
      if (evt.key !== "Enter" && evt.key !== " ") return;
      evt.preventDefault();
      pick();
    });
    return { el, fader, sketchNo, sketchTitle };
  }
}
