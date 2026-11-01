import { ItemView, setIcon, type WorkspaceLeaf } from "obsidian";
import type { CardState } from "../api/card";
import type { SyncloHost } from "../host";
import { progressWords, unit, type PendingJob } from "../jobs/jobs";
import { progressInputOf } from "../jobs/jobs";
import { cardProgressInput, changedSlide, heroSlide, imageKey, panelSlides, shareOf, type PanelSlide } from "../panel/model";
import { CardPoller } from "../panel/poller";

export const PANEL_VIEW = "synclo-panel";

/** A note's name, from its path. */
export function noteNameOf(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.md$/i, "");
}

/** Two stacked pictures, so one fades into the next. */
interface Fader {
  a: HTMLImageElement;
  b: HTMLImageElement;
  shown: string | null;
}

interface Frame {
  el: HTMLElement;
  fader: Fader;
  sketchNo: HTMLElement;
  sketchTitle: HTMLElement;
  sketch: HTMLElement;
}

interface Parts {
  from: HTMLElement;
  title: HTMLElement;
  status: HTMLElement;
  bar: HTMLElement;
  hero: HTMLElement;
  heroFader: Fader;
  heroSketch: HTMLElement;
  heroNo: HTMLElement;
  heroTitle: HTMLElement;
  heroMsg: HTMLElement;
  prev: HTMLButtonElement;
  next: HTMLButtonElement;
  cap: HTMLElement;
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
 * note and says when it is ready or failed.
 */
export class SyncloPanelView extends ItemView {
  private target: PendingJob | null = null;
  private poller: CardPoller | null = null;
  private card: CardState | null = null;
  private slides: PanelSlide[] = [];
  private lastChanged: number | null = null;
  private picked: number | null = null;
  /** Each picture's first address (kept, so a fresh signature never
   *  reloads it) and its latest (used if the first one expires). */
  private firstAddress = new Map<string, string>();
  private latestAddress = new Map<string, string>();
  private parts: Parts | null = null;

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
    // Asked only while it can be seen: again as soon as it can.
    this.registerDomEvent(document, "visibilitychange", () => this.wake());
    this.registerEvent(this.app.workspace.on("layout-change", () => this.wake()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.wake()));
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
    this.poller?.stop();
    this.poller = null;
  }

  onResize(): void {
    this.wake();
  }

  /** Asks Synclo again now, if the panel is following a deck. */
  wake(): void {
    this.poller?.wake();
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
    this.poller?.stop();
    this.poller = null;
    this.target = target;
    this.card = null;
    this.slides = [];
    this.lastChanged = null;
    this.picked = null;
    this.firstAddress.clear();
    this.latestAddress.clear();
    this.build();
    if (!target) return;
    this.poller = new CardPoller({
      ask: () => this.host.api.cardState(target.generationId),
      onAnswer: (card) => this.answer(card),
      visible: () => activeDocument.visibilityState === "visible" && this.containerEl.isShown(),
      timers: { set: (fn, ms) => window.setTimeout(fn, ms), clear: (id) => window.clearTimeout(id) },
    });
    this.poller.wake();
  }

  private answer(card: CardState): void {
    const slides = panelSlides(card);
    for (const s of slides) {
      if (!s.image) continue;
      const key = imageKey(s.image);
      this.latestAddress.set(key, s.image);
      if (!this.firstAddress.has(key)) this.firstAddress.set(key, s.image);
    }
    const changed = changedSlide(this.slides, slides);
    if (changed !== null) this.lastChanged = changed;
    this.card = card;
    this.slides = slides;
    // Shared with the status bar; the board tells when it changed. Drawn
    // here too, for the slides even when where it stands is unchanged.
    if (this.target) this.host.progressBoard.update(this.target.generationId, cardProgressInput(card));
    this.render();
  }

  /** The address to show for a picture: the first one seen for it. */
  private address(image: string | null): string | null {
    return image ? (this.firstAddress.get(imageKey(image)) ?? image) : null;
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
    const status = body.createDiv({ cls: "synclo-panel-status" });
    const bar = body.createDiv({ cls: "synclo-panel-bar" });
    bar.createEl("i");

    const hero = body.createDiv({ cls: "synclo-panel-hero" });
    const heroSketch = hero.createDiv({ cls: "synclo-sketch" });
    const heroNo = heroSketch.createDiv({ cls: "synclo-sketch-no" });
    const heroTitle = heroSketch.createDiv({ cls: "synclo-sketch-title" });
    const heroFader = this.fader(hero);
    const heroMsg = hero.createDiv({ cls: "synclo-panel-msg" });
    const prev = hero.createEl("button", { cls: "synclo-panel-nav is-prev", attr: { "aria-label": "Previous slide", type: "button" } });
    setIcon(prev, "chevron-left");
    const next = hero.createEl("button", { cls: "synclo-panel-nav is-next", attr: { "aria-label": "Next slide", type: "button" } });
    setIcon(next, "chevron-right");
    prev.addEventListener("click", () => this.step(-1));
    next.addEventListener("click", () => this.step(1));

    const cap = body.createDiv({ cls: "synclo-panel-cap" });
    const actions = body.createDiv({ cls: "synclo-panel-actions" });
    const open = actions.createEl("button", { cls: "mod-cta", text: "Open in Synclo" });
    const pptx = actions.createEl("button", { text: "Download PowerPoint" });
    const pdf = actions.createEl("button", { text: "Download PDF" });
    open.addEventListener("click", () => {
      const doc = this.card?.document;
      if (doc) this.host.openExternal(doc.editUrl);
    });
    pptx.addEventListener("click", () => this.download("pptx"));
    pdf.addEventListener("click", () => this.download("pdf"));
    const meta = body.createDiv({ cls: "synclo-panel-meta" });
    const grid = body.createDiv({ cls: "synclo-panel-grid" });

    this.parts = { from, title, status, bar, hero, heroFader, heroSketch, heroNo, heroTitle, heroMsg, prev, next, cap, actions, meta, grid, frames: [] };
    this.render();
  }

  private fader(parent: HTMLElement): Fader {
    const a = parent.createEl("img", { cls: "synclo-fade", attr: { alt: "" } });
    const b = parent.createEl("img", { cls: "synclo-fade", attr: { alt: "" } });
    const fader: Fader = { a, b, shown: null };
    for (const img of [a, b]) {
      // An address past its hour: the latest one for the same picture.
      img.addEventListener("error", () => {
        const src = img.getAttribute("src");
        if (!src) return;
        const latest = this.latestAddress.get(imageKey(src));
        if (latest && latest !== src) {
          this.firstAddress.set(imageKey(src), latest);
          img.setAttribute("src", latest);
        }
      });
    }
    return fader;
  }

  /** Shows `address` in a fader, fading from what it showed. */
  private fade(f: Fader, address: string | null): void {
    if (f.shown === address) return;
    f.shown = address;
    if (!address) {
      f.a.removeClass("is-on");
      f.b.removeClass("is-on");
      return;
    }
    const on = f.a.hasClass("is-on") ? f.a : f.b;
    const off = on === f.a ? f.b : f.a;
    const show = () => {
      if (f.shown !== address) return;
      off.addClass("is-on");
      on.removeClass("is-on");
    };
    off.addEventListener("load", show, { once: true });
    off.setAttribute("src", address);
  }

  private step(by: number): void {
    const n = this.slides.length;
    if (!n) return;
    const at = heroSlide(this.slides, this.lastChanged, this.picked, true) ?? 0;
    this.picked = (at + by + n) % n;
    this.render();
  }

  private download(format: "pptx" | "pdf"): void {
    const doc = this.card?.document;
    if (!doc || !this.target) return;
    const note = this.app.vault.getFileByPath(this.target.notePath);
    void this.host.download(doc.id, format, note, doc.title);
  }

  private render(): void {
    const p = this.parts;
    const target = this.target;
    if (!p || !target) return;
    const card = this.card;
    const name = noteNameOf(target.notePath);
    const format = card?.format ?? target.format;
    const ready = card?.status === "completed";
    const failed = card?.status === "failed";
    const slides = this.slides;

    // The deck's own colors on its sketches, once Synclo has chosen them.
    this.contentEl.setCssProps({
      "--synclo-sketch-bg": card?.colors?.slide ?? "",
      "--synclo-sketch-ink": card?.colors?.heading ?? "",
    });
    this.contentEl.toggleClass("has-colors", !!card?.colors);

    p.from.setText(`From “${name}”`);
    p.title.setText(card && card.frames.length ? (card.title ?? card.document?.title ?? name) : name);

    // Where it stands: the newest answer, this panel's or the job runner's
    // (the status bar reads the same).
    const progress = this.host.progressBoard.get(target.generationId) ?? (card ? cardProgressInput(card) : progressInputOf(null));
    const words = progressWords(progress, format, name, false);
    const done = ready || progress.status === "completed";
    const statusLine = failed ? (card?.error?.message ?? "") : words.line;
    p.status.setText(statusLine);
    p.status.toggle(!done && !!statusLine);

    const share = shareOf(progress);
    p.bar.toggle(!done && !failed);
    p.bar.toggleClass("is-waiting", share === null);
    p.bar.setCssProps({ "--synclo-progress": share === null ? "" : `${Math.round(share * 100)}%` });

    // The large frame: the slide that changed last (or the one picked).
    const at = heroSlide(slides, this.lastChanged, this.picked, ready);
    const shown = at !== null ? slides[at] : undefined;
    const image = this.address(shown?.image ?? null);
    this.fade(p.heroFader, image);
    p.heroSketch.toggle(!!shown && !image);
    if (shown) {
      p.heroNo.setText(String((at ?? 0) + 1).padStart(2, "0"));
      p.heroTitle.setText(shown.title);
    }
    // Before the plan: where it stands, in the frame.
    p.heroMsg.empty();
    p.heroMsg.toggle(!slides.length);
    if (!slides.length) {
      p.heroMsg.createSpan({ text: failed ? "" : words.line });
      if (!failed) p.heroMsg.createDiv({ cls: "synclo-shimmer" });
    }
    p.prev.toggle(ready && slides.length > 1);
    p.next.toggle(ready && slides.length > 1);
    p.cap.setText(shown ? `Slide ${(at ?? 0) + 1} · ${shown.title}` : "");

    const doc = card?.document ?? null;
    p.actions.toggle(ready && !!doc);
    const count = doc?.slides || slides.length;
    const note = this.app.vault.getFileByPath(target.notePath);
    const linked = !!doc && !!note && this.host.noteDocumentId(note) === doc.id;
    p.meta.toggle(ready && count > 0);
    p.meta.setText(`${count} ${unit(format, count)}.${linked ? " The link is in the note's properties." : ""}`);

    // Every slide: its sketch until it is drawn, then its picture.
    p.grid.toggle(slides.length > 0);
    while (p.frames.length < slides.length) p.frames.push(this.frame(p.grid, p.frames.length));
    while (p.frames.length > slides.length) p.frames.pop()?.el.remove();
    slides.forEach((s, i) => {
      const f = p.frames[i];
      if (!f) return;
      const pic = this.address(s.image);
      this.fade(f.fader, pic);
      f.el.toggleClass("has-picture", !!pic);
      // A drawn slide can be picked, by pointer or by keyboard.
      if (pic) {
        f.el.setAttribute("role", "button");
        f.el.setAttribute("tabindex", "0");
      } else {
        f.el.removeAttribute("role");
        f.el.removeAttribute("tabindex");
      }
      f.el.toggleClass("is-selected", !!pic && i === at && (ready || this.picked !== null));
      f.sketch.toggle(!pic);
      f.sketchNo.setText(String(i + 1).padStart(2, "0"));
      f.sketchTitle.setText(s.title);
    });
  }

  private frame(grid: HTMLElement, i: number): Frame {
    const el = grid.createDiv({ cls: "synclo-panel-frame" });
    const sketch = el.createDiv({ cls: "synclo-sketch" });
    const sketchNo = sketch.createDiv({ cls: "synclo-sketch-no" });
    const sketchTitle = sketch.createDiv({ cls: "synclo-sketch-title" });
    const fader = this.fader(el);
    const pick = () => {
      if (!el.hasClass("has-picture")) return;
      this.picked = i;
      this.render();
    };
    el.addEventListener("click", pick);
    el.addEventListener("keydown", (evt) => {
      if (evt.key !== "Enter" && evt.key !== " ") return;
      evt.preventDefault();
      pick();
    });
    return { el, fader, sketch, sketchNo, sketchTitle };
  }
}
