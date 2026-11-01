import { describe, expect, it } from "vitest";
import { parseCardState, type CardState } from "../src/api/card";
import { SyncloError } from "../src/api/errors";
import { progressWords } from "../src/jobs/jobs";
import { MAX_ASKS_WHEN_DONE, RETRY_FAILED_PICTURES_MS, askMore, changedSlide, heroSlide, imageKey, nextAsk, panelSlides, progressShare, type AskState } from "../src/panel/model";
import { CardPoller, type StopReason } from "../src/panel/poller";
import { DeckWatch } from "../src/panel/watch";
import type { PendingJob } from "../src/jobs/jobs";

const sig = (path: string, n = 1) => `https://store.synclo.test/cards/${path}.jpg?token=t${n}`;

function card(x: Record<string, unknown>): CardState {
  return parseCardState({ kind: "generation", status: "running", format: "slides", frames: [], ...x });
}

const frames = (n: number, written: number, drawn = written, sign = 1) =>
  Array.from({ length: n }, (_v, i) => ({ t: `Slide title ${i + 1}`, s: i < written ? "written" : "planned", pic: i < drawn ? sig(`f${i}`, sign) : null }));

describe("reading card_state", () => {
  it("reads every part, and leaves out what isn't valid", () => {
    const c = parseCardState({
      kind: "generation",
      status: "completed",
      error: null,
      format: "document",
      planned: 9,
      title: "  Riverside update  ",
      colors: { slide: "#f8f1e7", heading: "#203a2c", accent: "#c4452f" },
      step: "checking",
      frames: [{ t: "Opening", s: "written", pic: sig("a") }, { t: "Need grew", s: "planned", pic: "javascript:alert(1)" }],
      pictures: { made: 3, total: 6 },
      credits: { estimated: 90 },
      document: { id: "d1", title: "Riverside update", slides: 2, titles: ["Opening", "Need grew"], edit_url: "https://synclo.app/d/d1" },
      deck: { status: "drawing", pictures: [sig("d0"), null] },
    });
    expect(c.status).toBe("completed");
    expect(c.format).toBe("document");
    expect(c.title).toBe("Riverside update");
    expect(c.colors).toEqual({ slide: "#f8f1e7", heading: "#203a2c", accent: "#c4452f" });
    expect(c.frames).toEqual([
      { title: "Opening", written: true, pic: sig("a") },
      { title: "Need grew", written: false, pic: null },
    ]);
    expect(c.document?.editUrl).toBe("https://synclo.app/d/d1");
    expect(c.deck).toEqual({ status: "drawing", pictures: [sig("d0"), null] });
    expect(card({ colors: { slide: "red", heading: "#000000", accent: "#000000" } }).colors).toBeNull();
    expect(card({ deck: { status: "failed" } }).deck).toEqual({ status: "failed" });
    expect(card({ status: "completed", gone: true }).gone).toBe(true);
    expect(card({}).gone).toBe(false);
  });
});

describe("the slides the panel draws", () => {
  it("shows each slide's drawing as it is written", () => {
    const s = panelSlides(card({ frames: frames(4, 2) }));
    expect(s.map((x) => [x.title, x.image])).toEqual([
      ["Slide title 1", sig("f0")],
      ["Slide title 2", sig("f1")],
      ["Slide title 3", null],
      ["Slide title 4", null],
    ]);
  });

  it("puts the finished deck's pictures in place as they come, keeping the drawings until then", () => {
    const c = card({
      status: "completed",
      frames: frames(3, 3),
      document: { id: "d", title: "D", slides: 3, titles: ["Slide title 1", "Slide title 2", "Slide title 3"], edit_url: "https://synclo.app/d/d" },
      deck: { status: "drawing", pictures: [sig("d0"), null, sig("d2")] },
    });
    expect(panelSlides(c).map((x) => [x.title, x.image])).toEqual([
      ["Slide title 1", sig("d0")],
      ["Slide title 2", sig("f1")],
      ["Slide title 3", sig("d2")],
    ]);
  });

  it("once the presentation exists, draws its own count and titles, a missing picture in its place", () => {
    // The plan had 4 slides, the deck has 3; the finished pictures have a
    // gap: nothing moves up into it.
    const c = card({
      status: "completed",
      frames: frames(4, 4),
      document: { id: "d", title: "D", slides: 3, titles: ["Slide title 1", "A new second", "Slide title 3"], edit_url: "https://synclo.app/d/d" },
      deck: { status: "drawing", pictures: [null, null, sig("d2")] },
    });
    expect(panelSlides(c).map((x) => [x.title, x.image])).toEqual([
      ["Slide title 1", sig("f0")],
      // Another slide's drawing is never paired with this title.
      ["A new second", null],
      ["Slide title 3", sig("d2")],
    ]);
  });

  it("counts by the titles when the presentation gives no count", () => {
    const c = card({ status: "completed", document: { id: "d", title: "D", titles: ["One", "Two"], edit_url: "https://synclo.app/d/d" } });
    expect(panelSlides(c).map((x) => [x.title, x.image])).toEqual([
      ["One", null],
      ["Two", null],
    ]);
  });

  it("keeps the written drawings when the finished pictures fail", () => {
    const c = card({ status: "completed", frames: frames(2, 2), deck: { status: "failed" } });
    expect(panelSlides(c).map((x) => x.image)).toEqual([sig("f0"), sig("f1")]);
  });

  it("is empty before the plan", () => {
    expect(panelSlides(card({}))).toEqual([]);
  });
});

describe("which slide the large frame shows", () => {
  it("notices a new picture, not a fresh signature on the same one", () => {
    const before = panelSlides(card({ frames: frames(4, 2, 2, 1) }));
    const same = panelSlides(card({ frames: frames(4, 2, 2, 2) }));
    expect(imageKey(sig("f0", 1))).toBe(imageKey(sig("f0", 2)));
    expect(changedSlide(before, same)).toBeNull();
    const more = panelSlides(card({ frames: frames(4, 4, 4, 3) }));
    expect(changedSlide(before, more)).toBe(3);
  });

  it("shows the slide that changed last while it is made, or the one picked once drawn", () => {
    const slides = panelSlides(card({ frames: frames(5, 3) }));
    expect(heroSlide(slides, 2, null, false)).toBe(2);
    expect(heroSlide(slides, 2, 0, false)).toBe(0);
    expect(heroSlide(slides, 2, 4, false)).toBe(2);
    expect(heroSlide(slides, null, null, false)).toBe(0);
    expect(heroSlide([], null, null, false)).toBeNull();
  });

  it("shows the first slide once ready, or the one picked", () => {
    const slides = panelSlides(card({ frames: frames(5, 5) }));
    expect(heroSlide(slides, 4, null, true)).toBe(0);
    expect(heroSlide(slides, 4, 3, true)).toBe(3);
  });
});

describe("how far along the bar is", () => {
  it("runs without a measure before the plan, then fills with writing, images and finishing", () => {
    expect(progressShare(card({}))).toBeNull();
    expect(progressShare(card({ frames: frames(10, 0) }))).toBeCloseTo(0.04);
    expect(progressShare(card({ frames: frames(10, 5) }))).toBeCloseTo(0.37);
    expect(progressShare(card({ frames: frames(10, 10), pictures: { made: 3, total: 6 } }))).toBeCloseTo(0.83);
    expect(progressShare(card({ frames: frames(10, 10), pictures: { made: 6, total: 6 } }))).toBeCloseTo(1);
    expect(progressShare(card({ frames: frames(10, 10) }))).toBeCloseTo(1);
    expect(progressShare(card({ status: "completed", frames: frames(10, 10) }))).toBe(1);
  });

  it("says where it stands in the existing words", () => {
    const words = (c: CardState) =>
      progressWords({ status: c.status, title: c.title, step: c.step, started: c.step !== null || c.frames.length > 0, total: c.frames.length, written: c.frames.filter((f) => f.written).length, slideTitles: [], pictures: c.pictures }, c.format, "Donor update notes", false).line;
    expect(words(card({ status: "queued" }))).toBe("Waiting for Synclo to start…");
    expect(words(card({}))).toBe("Planning the slides…");
    expect(words(card({ frames: frames(11, 0) }))).toBe("Planned 11 slides");
    expect(words(card({ frames: frames(11, 4) }))).toBe("4 of 11 slides written");
    expect(words(card({ frames: frames(11, 11), pictures: { made: 2, total: 9 } }))).toBe("Adding images: 2 of 9");
    expect(words(card({ frames: frames(11, 11), pictures: { made: 9, total: 9 } }))).toBe("Finishing…");
  });
});

const fresh = (x: Partial<AskState> = {}): AskState => ({ asksWhenDone: 0, pictureRetries: 0, expired: false, ...x });

describe("when to ask again", () => {
  it("asks every 2.5 s while it is made and stops when there is nothing more to show", () => {
    expect(nextAsk(card({ status: "queued" }), fresh())).toBe(2500);
    expect(nextAsk(card({}), fresh())).toBe(2500);
    expect(nextAsk(card({ status: "failed" }), fresh())).toBeNull();
    expect(nextAsk(card({ status: "completed", deck: { status: "drawing", pictures: [null] } }), fresh({ asksWhenDone: 3 }))).toBe(0);
    expect(nextAsk(card({ status: "completed", deck: { status: "drawing", pictures: [null] } }), fresh({ asksWhenDone: MAX_ASKS_WHEN_DONE }))).toBeNull();
    expect(nextAsk(card({ status: "completed", deck: { status: "ready", pictures: [sig("x")] } }), fresh({ asksWhenDone: 1 }))).toBeNull();
    expect(nextAsk(card({ status: "completed" }), fresh({ asksWhenDone: 1 }))).toBeNull();
    expect(nextAsk(card({ status: "completed", gone: true, deck: { status: "drawing", pictures: [null] } }), fresh())).toBeNull();
  });

  it("stops after one last ask once the deck is past its time or given up on", () => {
    expect(nextAsk(card({}), fresh({ expired: true }))).toBeNull();
    expect(nextAsk(card({ status: "completed", deck: { status: "drawing", pictures: [null] } }), fresh({ expired: true }))).toBe(0);
  });

  it("asks once more, a minute later, for finished pictures that failed", () => {
    expect(nextAsk(card({ status: "completed", deck: { status: "failed" } }), fresh())).toBe(RETRY_FAILED_PICTURES_MS);
    expect(nextAsk(card({ status: "completed", deck: { status: "failed" } }), fresh({ pictureRetries: 1 }))).toBeNull();
  });

  it("knows when there is more to ask", () => {
    expect(askMore(null)).toBe(true);
    expect(askMore(card({}))).toBe(true);
    expect(askMore(card({ status: "completed", deck: { status: "ready", pictures: [] } }))).toBe(false);
    expect(askMore(card({ status: "failed" }))).toBe(false);
  });
});

function poller(answers: Array<CardState | Error | Promise<CardState>>, visible = () => true, opts: { expired?: () => boolean } = {}) {
  const seen: string[] = [];
  const stops: Array<[StopReason, string]> = [];
  let i = 0;
  let clock = 0;
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const p = new CardPoller({
    ask: () => {
      const a = answers[Math.min(i++, answers.length - 1)];
      return a instanceof Error ? Promise.reject(a) : Promise.resolve(a as CardState | Promise<CardState>);
    },
    onAnswer: (c) => seen.push(c.status),
    onStop: (reason, error) => stops.push([reason, error.message]),
    visible,
    expired: opts.expired ?? (() => false),
    timers: {
      set: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      clear: () => undefined,
    },
    now: () => clock,
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  /** Runs the next timer the poller set. */
  const tick = async () => {
    const t = timers.shift();
    t?.fn();
    await flush();
    return t?.ms;
  };
  const advance = (ms: number) => (clock += ms);
  return { p, seen, stops, asked: () => i, tick, flush, timers, advance };
}

describe("asking for the panel", () => {
  it("asks until the finished deck is shown, then stops", async () => {
    const t = poller([card({}), card({ status: "completed", deck: { status: "drawing", pictures: [null] } }), card({ status: "completed", deck: { status: "ready", pictures: [sig("x")] } })]);
    t.p.wake();
    await t.flush();
    expect(await t.tick()).toBe(2500);
    expect(await t.tick()).toBe(0);
    expect(t.seen).toEqual(["running", "completed", "completed"]);
    expect(t.p.finished).toBe(true);
    expect(t.timers).toHaveLength(0);
  });

  it("asks nothing while the panel can't be seen, and asks once it can", async () => {
    let shown = false;
    const t = poller([card({})], () => shown);
    t.p.wake();
    await t.flush();
    expect(t.asked()).toBe(0);
    shown = true;
    t.p.wake();
    await t.flush();
    expect(t.asked()).toBe(1);
  });

  it("keeps its pace when the panel comes into view again", async () => {
    const t = poller([card({}), card({})]);
    t.p.wake();
    await t.flush();
    t.p.wake();
    await t.flush();
    expect(t.asked()).toBe(1);
    expect(await t.tick()).toBe(2500);
    expect(t.asked()).toBe(2);
  });

  it("asks one at a time", async () => {
    const t = poller([card({})]);
    t.p.wake();
    t.p.wake();
    t.p.wake();
    await t.flush();
    expect(t.asked()).toBe(1);
  });

  it("backs off after a failure and tries again", async () => {
    const t = poller([new SyncloError("network", "offline"), new SyncloError("unavailable", "busy"), card({ status: "completed", deck: { status: "ready", pictures: [] } })]);
    t.p.wake();
    await t.flush();
    expect(await t.tick()).toBe(5000);
    expect(await t.tick()).toBe(10000);
    expect(t.seen).toEqual(["completed"]);
  });

  it("stops when the generation isn't there, and says so", async () => {
    const t = poller([new SyncloError("rejected", "No generation with that id in this workspace.", { code: "tool_error" })]);
    t.p.wake();
    await t.flush();
    expect(t.p.finished).toBe(true);
    expect(t.timers).toHaveLength(0);
    expect(t.stops.map((s) => s[0])).toEqual(["gone"]);
  });

  it("stops when signed out, or when the connection lacks the right, and says which", async () => {
    const out = poller([new SyncloError("signed-out", "Connect")]);
    out.p.wake();
    await out.flush();
    expect(out.stops.map((s) => s[0])).toEqual(["signed-out"]);
    const scope = poller([new SyncloError("rejected", "This connection can't do that.", { code: "insufficient_scope" })]);
    scope.p.wake();
    await scope.flush();
    expect(scope.stops).toEqual([["scope", "This connection can't do that."]]);
  });

  it("tries Synclo's own failure again", async () => {
    const t = poller([new SyncloError("rejected", "Internal error", { code: "server_error" }), card({})]);
    t.p.wake();
    await t.flush();
    expect(t.stops).toEqual([]);
    expect(await t.tick()).toBe(5000);
    expect(t.seen).toEqual(["running"]);
  });

  it("asks once more for a deck past its time, then stops and says so", async () => {
    const t = poller([card({}), card({})], () => true, { expired: () => true });
    t.p.wake();
    await t.flush();
    expect(t.asked()).toBe(1);
    expect(t.p.finished).toBe(true);
    expect(t.timers).toHaveLength(0);
    expect(t.stops.map((s) => s[0])).toEqual(["expired"]);
  });

  it("asks for failed finished pictures once more, a minute later", async () => {
    const failed = card({ status: "completed", deck: { status: "failed" } });
    const t = poller([failed, failed]);
    t.p.wake();
    await t.flush();
    expect(await t.tick()).toBe(RETRY_FAILED_PICTURES_MS);
    expect(t.asked()).toBe(2);
    expect(t.p.finished).toBe(true);
    expect(t.timers).toHaveLength(0);
  });

  it("gives up an ask left hanging when the panel is seen again, and asks fresh", async () => {
    const hanging = new Promise<CardState>(() => undefined);
    const t = poller([hanging, card({})]);
    t.p.wake();
    await t.flush();
    expect(t.asked()).toBe(1);
    // Seen again soon: the ask is still fair.
    t.advance(5_000);
    t.p.wake();
    await t.flush();
    expect(t.asked()).toBe(1);
    // Seen again after 15 s: asked afresh.
    t.advance(11_000);
    t.p.wake();
    await t.flush();
    expect(t.asked()).toBe(2);
    expect(t.seen).toEqual(["running"]);
  });

  it("ignores an answer to an ask it gave up on", async () => {
    let answerFirst: (c: CardState) => void = () => undefined;
    const first = new Promise<CardState>((r) => (answerFirst = r));
    const t = poller([first, new Promise<CardState>(() => undefined)]);
    t.p.wake();
    await t.flush();
    t.advance(20_000);
    t.p.wake();
    await t.flush();
    answerFirst(card({ status: "completed", deck: { status: "ready", pictures: [] } }));
    await t.flush();
    expect(t.seen).toEqual([]);
    expect(t.p.finished).toBe(false);
  });
});

const job: PendingJob = { generationId: "g1", notePath: "Notes/Donor update.md", title: "Donor update", format: "slides", base: "https://synclo.app", startedAt: 0 };

function watched(answers: CardState[], opts: { signedIn?: () => boolean } = {}) {
  let asks = 0;
  const cards: string[] = [];
  const timers: Array<() => void> = [];
  const w = new DeckWatch(job, {
    ask: () => Promise.resolve(answers[Math.min(asks++, answers.length - 1)] as CardState),
    onCard: (_id, c) => cards.push(c.status),
    expired: () => false,
    signedIn: opts.signedIn ?? (() => true),
    timers: {
      set: (fn) => {
        timers.push(fn);
        return timers.length;
      },
      clear: () => undefined,
    },
    now: () => 0,
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { w, asked: () => asks, cards, flush, timers };
}

describe("one watch on a deck for every panel", () => {
  it("asks once for two panels, while either can be seen, and stops when none shows it", async () => {
    const t = watched([card({ frames: frames(3, 1) })]);
    let aShown = false;
    let bShown = false;
    let drawn = 0;
    const offA = t.w.subscribe({ changed: () => drawn++, visible: () => aShown });
    const offB = t.w.subscribe({ changed: () => drawn++, visible: () => bShown });
    await t.flush();
    expect(t.asked()).toBe(0);
    bShown = true;
    t.w.wake();
    await t.flush();
    expect(t.asked()).toBe(1);
    // Both panels drew the answer, and the board was told once.
    expect(drawn).toBe(2);
    expect(t.cards).toEqual(["running"]);
    expect(t.w.slides).toHaveLength(3);
    offA();
    offB();
    t.timers.shift()?.();
    await t.flush();
    expect(t.asked()).toBe(1);
  });

  it("says signed out without asking, and asks again once restarted", async () => {
    let signedIn = false;
    const t = watched([card({})], { signedIn: () => signedIn });
    t.w.subscribe({ changed: () => undefined, visible: () => true });
    await t.flush();
    expect(t.asked()).toBe(0);
    expect(t.w.stopped?.reason).toBe("signed-out");
    signedIn = true;
    t.w.restart();
    await t.flush();
    expect(t.w.stopped).toBeNull();
    expect(t.asked()).toBe(1);
  });

  it("keeps a picture's first address, and offers the newest when it fails", async () => {
    const t = watched([card({ frames: frames(2, 2, 2, 1) }), card({ frames: frames(2, 2, 2, 2) })]);
    t.w.subscribe({ changed: () => undefined, visible: () => true });
    await t.flush();
    t.timers.shift()?.();
    await t.flush();
    expect(t.w.address(sig("f0", 2))).toBe(sig("f0", 1));
    expect(t.w.fresher(sig("f0", 1))).toBe(sig("f0", 2));
    expect(t.w.address(sig("f0", 2))).toBe(sig("f0", 2));
    expect(t.w.fresher(sig("f0", 2))).toBeNull();
  });
});
