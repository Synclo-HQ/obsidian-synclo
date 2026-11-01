import { describe, expect, it } from "vitest";
import { parseCardState, type CardState } from "../src/api/card";
import type { PendingJob } from "../src/jobs/jobs";
import { clampSlide, deckStateOf, deckStateRecord, fitBox, keyStep, swipeStep } from "../src/panel/viewer";
import { ADDRESS_FRESH_MS, DeckWatch } from "../src/panel/watch";

const job: PendingJob = { generationId: "gen_1", notePath: "Notes/Donor update.md", title: "Donor update", format: "slides", base: "https://synclo.app", startedAt: 1_700_000_000_000 };

describe("which slide the viewer shows", () => {
  it("keeps the index inside the deck", () => {
    expect(clampSlide(3, 10)).toBe(3);
    expect(clampSlide(-1, 10)).toBe(0);
    expect(clampSlide(12, 10)).toBe(9);
    expect(clampSlide(2.7, 10)).toBe(2);
    expect(clampSlide(Number.NaN, 10)).toBe(0);
    expect(clampSlide(4, 0)).toBe(0);
  });

  it("steps with the arrows and Page keys, stopping at the ends; Home and End go to the ends", () => {
    expect(keyStep("ArrowRight", 3, 10)).toBe(4);
    expect(keyStep("PageDown", 3, 10)).toBe(4);
    expect(keyStep("ArrowLeft", 3, 10)).toBe(2);
    expect(keyStep("PageUp", 3, 10)).toBe(2);
    expect(keyStep("ArrowLeft", 0, 10)).toBe(0);
    expect(keyStep("ArrowRight", 9, 10)).toBe(9);
    expect(keyStep("Home", 6, 10)).toBe(0);
    expect(keyStep("End", 2, 10)).toBe(9);
    expect(keyStep("a", 3, 10)).toBeNull();
    expect(keyStep("ArrowUp", 3, 10)).toBeNull();
    expect(keyStep("ArrowRight", 0, 0)).toBeNull();
  });

  it("steps on a sideways swipe only", () => {
    expect(swipeStep(-120, 10)).toBe(1);
    expect(swipeStep(120, -10)).toBe(-1);
    expect(swipeStep(-20, 0)).toBe(0);
    expect(swipeStep(-80, 90)).toBe(0);
  });
});

describe("how large the slide is drawn", () => {
  it("fits a 16:9 slide in the room, wide or tall", () => {
    expect(fitBox({ w: 1600, h: 600 }, null)).toEqual({ w: 1066, h: 599 });
    expect(fitBox({ w: 800, h: 900 }, null)).toEqual({ w: 800, h: 450 });
  });

  it("never draws a picture larger than it is", () => {
    expect(fitBox({ w: 2400, h: 1600 }, { w: 1200, h: 675 })).toEqual({ w: 1200, h: 675 });
    // Before its picture loads, the deck's pictures' size holds it.
    expect(fitBox({ w: 2400, h: 1600 }, null, { w: 1200, h: 675 })).toEqual({ w: 1200, h: 675 });
  });

  it("keeps a picture's own shape, so a document's tall section is shown whole", () => {
    expect(fitBox({ w: 1000, h: 800 }, { w: 1200, h: 2400 })).toEqual({ w: 400, h: 800 });
  });

  it("draws nothing in no room", () => {
    expect(fitBox({ w: 0, h: 500 }, null)).toEqual({ w: 0, h: 0 });
  });
});

describe("a viewer tab across a restart", () => {
  it("keeps the deck and the slide", () => {
    const kept = deckStateRecord({ job: { ...job, workspace: { id: "ws_1", name: "Studio" } }, slide: 4 });
    const back = deckStateOf(JSON.parse(JSON.stringify(kept)));
    expect(back).toEqual({ job: { ...job, workspace: { id: "ws_1", name: "Studio" } }, slide: 4 });
  });

  it("reads a document's sections and a bad slide safely", () => {
    expect(deckStateOf({ ...deckStateRecord({ job: { ...job, format: "document" }, slide: 0 }), slide: -3 })).toEqual({ job: { ...job, format: "document" }, slide: 0 });
    expect(deckStateOf({ ...deckStateRecord({ job, slide: 0 }), slide: "2" })?.slide).toBe(0);
  });

  it("names no deck from an empty or broken state", () => {
    expect(deckStateOf({})).toBeNull();
    expect(deckStateOf(null)).toBeNull();
    expect(deckStateOf({ generationId: "gen_1" })).toBeNull();
  });
});

const sig = (path: string, n: number) => `https://store.synclo.test/cards/${path}.jpg?token=t${n}`;
const finished = (n: number): CardState =>
  parseCardState({
    status: "completed",
    format: "slides",
    frames: [],
    document: { id: "d", title: "Donor update", slides: 1, titles: ["Opening"], edit_url: "https://synclo.app/d/d" },
    deck: { status: "ready", pictures: [sig("p0", n)] },
  });

describe("picture addresses that last an hour", () => {
  it("keeps the first address until it nears its end, then asks again and uses the newest", async () => {
    let clock = 0;
    let asks = 0;
    const w = new DeckWatch(job, {
      ask: () => Promise.resolve(finished(++asks)),
      onCard: () => undefined,
      expired: () => false,
      signedIn: () => true,
      timers: { set: () => 0, clear: () => undefined },
      now: () => clock,
    });
    const flush = () => new Promise((r) => setTimeout(r, 0));
    w.subscribe({ changed: () => undefined, visible: () => true });
    await flush();
    expect(asks).toBe(1);
    expect(w.address(sig("p0", 1))).toBe(sig("p0", 1));
    // Seen again soon: nothing asked, the same address.
    clock = 10 * 60 * 1000;
    w.wake();
    await flush();
    expect(asks).toBe(1);
    // Seen again near the end of the hour: asked once more.
    clock = ADDRESS_FRESH_MS + 1;
    w.wake();
    w.wake();
    await flush();
    expect(asks).toBe(2);
    expect(w.address(sig("p0", 2))).toBe(sig("p0", 2));
  });
});
