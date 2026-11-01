import { describe, expect, it } from "vitest";
import { parseCardState, type CardState } from "../src/api/card";
import { SyncloError } from "../src/api/errors";
import { progressWords } from "../src/jobs/jobs";
import { MAX_ASKS_WHEN_DONE, changedSlide, heroSlide, imageKey, nextAsk, panelSlides, progressShare } from "../src/panel/model";
import { CardPoller } from "../src/panel/poller";

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
    const c = card({ status: "completed", frames: frames(3, 3), document: { id: "d", title: "D", slides: 3, titles: ["One", "Two", "Three"], edit_url: "https://synclo.app/d/d" }, deck: { status: "drawing", pictures: [sig("d0"), null, sig("d2")] } });
    expect(panelSlides(c).map((x) => [x.title, x.image])).toEqual([
      ["One", sig("d0")],
      ["Two", sig("f1")],
      ["Three", sig("d2")],
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

describe("when to ask again", () => {
  it("asks every 2.5 s while it is made and stops when there is nothing more to show", () => {
    expect(nextAsk(card({ status: "queued" }), 0)).toBe(2500);
    expect(nextAsk(card({}), 0)).toBe(2500);
    expect(nextAsk(card({ status: "failed" }), 0)).toBeNull();
    expect(nextAsk(card({ status: "completed", deck: { status: "drawing", pictures: [null] } }), 3)).toBe(0);
    expect(nextAsk(card({ status: "completed", deck: { status: "drawing", pictures: [null] } }), MAX_ASKS_WHEN_DONE)).toBeNull();
    expect(nextAsk(card({ status: "completed", deck: { status: "ready", pictures: [sig("x")] } }), 1)).toBeNull();
    expect(nextAsk(card({ status: "completed", deck: { status: "failed" } }), 1)).toBeNull();
    expect(nextAsk(card({ status: "completed" }), 1)).toBeNull();
  });
});

function poller(answers: Array<CardState | Error>, visible = () => true) {
  const seen: string[] = [];
  let i = 0;
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const p = new CardPoller({
    ask: () => {
      const a = answers[Math.min(i++, answers.length - 1)];
      return a instanceof Error ? Promise.reject(a) : Promise.resolve(a as CardState);
    },
    onAnswer: (c) => seen.push(c.status),
    visible,
    timers: {
      set: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      clear: () => undefined,
    },
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  /** Runs the next timer the poller set. */
  const tick = async () => {
    const t = timers.shift();
    t?.fn();
    await flush();
    return t?.ms;
  };
  return { p, seen, asked: () => i, tick, flush, timers };
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

  it("stops when the generation isn't there", async () => {
    const t = poller([new SyncloError("rejected", "No generation with that id in this workspace.", { code: "tool_error" })]);
    t.p.wake();
    await t.flush();
    expect(t.p.finished).toBe(true);
    expect(t.timers).toHaveLength(0);
  });
});
