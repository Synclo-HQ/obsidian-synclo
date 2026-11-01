import { describe, expect, it } from "vitest";
import { fetchFile, freePath, safeFileName } from "../src/files";
import { DEFAULT_SETTINGS, lengthOptions, parseSettings } from "../src/settings";
import { fakeHttp, type FakeAnswer } from "./fake-http";

describe("downloading a file", () => {
  it("follows Synclo's file link to storage, without the sign-in", async () => {
    const handler = (req: { url: string }): FakeAnswer => {
      if (req.url.startsWith("https://synclo.app/files/")) return { status: 302, headers: { location: "https://storage.example/exports/q3.pptx?token=abc" } };
      return { status: 200, raw: "PPTX-BYTES", headers: { "content-type": "application/vnd.openxmlformats-officedocument.presentationml.presentation" } };
    };
    const { http, requests } = fakeHttp(handler);
    const bytes = await fetchFile(http, "https://synclo.app/files/AbC123/Q3%20review.pptx");
    expect(new TextDecoder().decode(bytes)).toBe("PPTX-BYTES");
    expect(requests.map((r) => r.url)).toEqual(["https://synclo.app/files/AbC123/Q3%20review.pptx", "https://storage.example/exports/q3.pptx?token=abc"]);
    expect(requests.every((r) => !r.headers?.Authorization)).toBe(true);
  });

  it("says when the link expired", async () => {
    const { http } = fakeHttp(() => ({ status: 410 }));
    await expect(fetchFile(http, "https://synclo.app/files/x/y.pdf")).rejects.toMatchObject({ code: "expired" });
  });

  it("stops after too many redirects", async () => {
    const { http } = fakeHttp(() => ({ status: 302, headers: { location: "https://synclo.app/files/loop" } }));
    await expect(fetchFile(http, "https://synclo.app/files/loop")).rejects.toMatchObject({ code: "redirect" });
  });
});

describe("file names", () => {
  it("makes names every system accepts", () => {
    expect(safeFileName("Q3: review / plan.pptx", "pptx")).toBe("Q3 review plan.pptx");
    expect(safeFileName("  ..hidden.. ", "pdf")).toBe("hidden.pdf");
    expect(safeFileName("[[x]]#^|", "pdf", "Deck")).toBe("x.pdf");
    expect(safeFileName("", "pdf", "Deck")).toBe("Deck.pdf");
    expect(safeFileName("a\u0007b", "pdf")).toBe("ab.pdf");
  });

  it("never overwrites a file", () => {
    const taken = new Set(["Notes/Q3.pptx", "Notes/Q3 1.pptx"]);
    expect(freePath("Notes", "Q3.pptx", (p) => taken.has(p))).toBe("Notes/Q3 2.pptx");
    expect(freePath("", "Q3.pdf", () => false)).toBe("Q3.pdf");
  });
});

describe("settings", () => {
  it("reads saved settings defensively", () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings({ slides: 12, format: "document", saveTo: "attachments", keepWords: true, base: "http://localhost:3000", junk: 1 })).toEqual({
      ...DEFAULT_SETTINGS,
      slides: 12,
      format: "document",
      saveTo: "attachments",
      keepWords: true,
      base: "http://localhost:3000",
    });
    expect(parseSettings({ slides: -1, format: "poster" })).toEqual(DEFAULT_SETTINGS);
  });

  it("offers lengths up to the plan's limit", () => {
    expect(lengthOptions(10, 8)).toEqual([3, 5, 6, 8, 10]);
    expect(lengthOptions(12, 7)).toEqual([3, 5, 6, 7, 8, 10, 12]);
    expect(lengthOptions(null, 20)).toEqual([3, 5, 6, 8, 10]);
  });
});
