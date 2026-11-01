import { describe, expect, it } from "vitest";
import { SyncloError } from "../src/api/errors";
import { PRESS_KEEP_MS, outcomeUnknown, parsePress, pressFor, requestKey } from "../src/ui/press";

let n = 0;
const newId = () => `press-${++n}`;

describe("a press of Make", () => {
  const request = { input: "# Notes", mode: "preserve", format: "slides", slides: 8 };
  const key = requestKey(request);

  it("tells requests apart without keeping their words", () => {
    expect(requestKey({ ...request })).toBe(key);
    expect(requestKey({ ...request, slides: 9 })).not.toBe(key);
    expect(key).not.toContain("Notes");
  });

  it("is the same press when pressed again for the same note and request within ten minutes", () => {
    const first = pressFor(null, "a.md", key, 1_000, newId);
    expect(pressFor(first, "a.md", key, 1_000 + PRESS_KEEP_MS - 1, newId).id).toBe(first.id);
  });

  it("is a new press for another note, another request, or after ten minutes", () => {
    const first = pressFor(null, "a.md", key, 1_000, newId);
    expect(pressFor(first, "b.md", key, 2_000, newId).id).not.toBe(first.id);
    expect(pressFor(first, "a.md", requestKey({ ...request, slides: 9 }), 2_000, newId).id).not.toBe(first.id);
    expect(pressFor(first, "a.md", key, 1_000 + PRESS_KEEP_MS, newId).id).not.toBe(first.id);
    // A clock set back never keeps an old press alive.
    expect(pressFor(first, "a.md", key, 500, newId).id).not.toBe(first.id);
  });

  it("is kept only when the failure may have reached Synclo", () => {
    expect(outcomeUnknown(new SyncloError("network", "offline"))).toBe(true);
    expect(outcomeUnknown(new SyncloError("unavailable", "busy"))).toBe(true);
    expect(outcomeUnknown(new SyncloError("rejected", "out", { code: "insufficient_credits" }))).toBe(false);
    expect(outcomeUnknown(new Error("x"))).toBe(false);
  });

  it("reads back only a whole press", () => {
    const p = pressFor(null, "a.md", key, 1_000, newId);
    expect(parsePress(JSON.parse(JSON.stringify(p)))).toEqual(p);
    expect(parsePress({ notePath: "a.md", id: "x" })).toBeNull();
    expect(parsePress(null)).toBeNull();
  });
});
