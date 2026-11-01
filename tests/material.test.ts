import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildMaterial, previewText, withPictures, type Material } from "../src/material/build";
import { describeLeftOut } from "../src/material/left-out";
import { expected, fakeUrls, fixtureNote, fixtureReader } from "./helpers";

/**
 * The awkward notes in tests/fixtures/vault, each made into material and
 * compared with tests/fixtures/expected/<name>.txt (the exact text Synclo
 * receives, pictures at stand-in addresses). Run with UPDATE_EXPECTED=1 to
 * rewrite the expected files after a deliberate change, then read the diff.
 */

async function material(path: string, includeLinked = false): Promise<Material> {
  return buildMaterial(fixtureNote(path), fixtureReader, { includeLinked });
}

function sent(m: Material): string {
  return withPictures(m, fakeUrls(m.pictures.length));
}

function check(name: string, text: string) {
  if (process.env.UPDATE_EXPECTED) writeFileSync(join(__dirname, "fixtures", "expected", name), `${text}\n`);
  expect(text).toBe(expected(name));
}

describe("a map note of only links", () => {
  it("sends the link names and says the note is mostly links", async () => {
    const m = await material("Map of projects.md");
    check("map-of-projects.txt", sent(m));
    expect(m.title).toBe("Map of projects");
    expect(m.mostlyLinks).toBe(true);
    expect(m.linkedNotes).toEqual([]);
    expect(m.words).toBe(15);
  });

  it("includes each linked note once, one level deep, as its own part", async () => {
    const m = await material("Map of projects.md", true);
    check("map-of-projects-linked.txt", sent(m));
    expect(m.linkedNotes).toEqual(["Apollo launch plan", "Garden redesign", "Reading list", "Budget"]);
    expect(m.mostlyLinks).toBe(false);
    expect(m.pictures.map((p) => p.file.path)).toEqual(["attachments/apollo-screen.png"]);
    expect(m.text.split("\n---\n").length).toBe(5);
    expect(m.text).not.toContain("Don't mention the price");
  });
});

describe("nested embeds", () => {
  it("inlines notes, sections and blocks one level deep", async () => {
    const m = await material("Launch update.md");
    check("launch-update.txt", sent(m));
    expect(describeLeftOut(m.leftOut)).toBe("1 embed of a missing note, 1 embed inside an embedded note");
    expect(m.pictures).toEqual([]);
  });
});

describe("comments inside and outside code fences", () => {
  it("never sends a comment, keeps code as written, leaves queries out", async () => {
    const m = await material("Comments and code.md");
    const text = sent(m);
    check("comments-and-code.txt", text);
    for (const secret of ["private aside", "board doesn't know", "whole private paragraph", "several lines", "HTML comment", "runs over two lines", "comment in the callout"]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain("// %% this is code, not a comment %%");
    expect(text).toContain("`%%kept%%`");
    expect(text).not.toContain("TABLE status");
    expect(text).not.toContain("dv.pages");
    expect(describeLeftOut(m.leftOut)).toBe("1 Bases view, 5 Dataview queries, 1 search query, 1 Tasks query, private comments");
  });
});

describe("frontmatter with Dataview fields", () => {
  it("names the deck from the frontmatter title and reads fields as words", async () => {
    const m = await material("Field notes.md");
    check("field-notes.txt", sent(m));
    expect(m.title).toBe("Q3 field notes");
    expect(sent(m)).not.toContain("author: Ana");
  });
});

describe("pictures in both syntaxes", () => {
  it("lists the note's own pictures once each and says what can't be sent", async () => {
    const m = await material("Pictures.md");
    check("pictures.txt", sent(m));
    expect(m.pictures.map((p) => [p.file.path, p.alt, p.type])).toEqual([
      ["attachments/team.jpg", "team", "image/jpeg"],
      ["attachments/diagram.webp", "Architecture diagram", "image/webp"],
      ["attachments/team photo-2026.jpg", "team photo 2026", "image/jpeg"],
      ["attachments/chart 1.png", "Sales chart", "image/png"],
      ["attachments/office view.jpeg", "The office", "image/jpeg"],
      ["attachments/Pasted image 20261031101500.png", "", "image/png"],
    ]);
    expect(m.remotePictures).toBe(1);
    expect(describeLeftOut(m.leftOut)).toBe(
      "1 PDF, 1 canvas, 1 drawing, 1 audio file, 1 video, 1 GIF, 1 SVG image, 1 picture over 8 MB, 1 picture written into the note as data, 2 pictures not found in the vault",
    );
    expect(previewText(m)).toContain("[Picture: Architecture diagram]");
  });

  it("keeps the Excalidraw drawing's words and nothing of its data", async () => {
    const text = sent(await material("Pictures.md"));
    expect(text).toContain("Checkout flow");
    expect(text).not.toContain("N4KAkARAL");
    expect(text).not.toContain("EXCALIDRAW VIEW");
  });

  it("leaves a picture out when it couldn't be uploaded", async () => {
    const m = await material("Pictures.md");
    const text = withPictures(m, new Map([[1, "https://img.synclo.test/one.jpg"]]));
    expect(text).toContain("![team](https://img.synclo.test/one.jpg)");
    expect(text).toContain("![The team, again](https://img.synclo.test/one.jpg)");
    expect(text).not.toContain("Architecture diagram");
    expect(text).not.toMatch(/\u0000/);
    expect(text).not.toMatch(/^- $/m);
  });
});

describe("non-English text", () => {
  it("keeps the words and removes the tags", async () => {
    const m = await material("Non-English.md");
    check("non-english.txt", sent(m));
    expect(m.words).toBeGreaterThan(20);
  });
});

describe("a 20-word note", () => {
  it("is source material at 20 words", async () => {
    const m = await material("Short note.md");
    check("short-note.txt", sent(m));
    expect(m.sourceWords).toBeGreaterThanOrEqual(20);
  });

  it("is a brief below 20 words", async () => {
    const note = fixtureNote("Short note.md");
    const m = await buildMaterial({ ...note, file: { ...note.file, basename: "Offsite" }, markdown: "A cooking class, a hike, and a talk." }, fixtureReader, { includeLinked: false });
    expect(m.sourceWords).toBeLessThan(20);
  });
});

describe("callouts, highlights, tasks, footnotes, math, tables, Mermaid", () => {
  it("keeps them, readably", async () => {
    const m = await material("Callouts and marks.md");
    check("callouts-and-marks.txt", sent(m));
  });
});

describe("Admonition blocks", () => {
  it("reads as a quote with its title", async () => {
    check("admonition.txt", sent(await material("Admonition.md")));
  });
});

describe("a selection", () => {
  it("sends only the selected text under the note's title", async () => {
    const note = fixtureNote("Projects/Apollo launch.md");
    const m = await buildMaterial({ ...note, markdown: "## Risks\n\n- The payment provider review may take two weeks. ^payments\n- Our designer is away for a week. #risk", selection: true }, fixtureReader, {
      includeLinked: false,
    });
    expect(m.text).toBe("# Apollo launch plan\n\n## Risks\n\n- The payment provider review may take two weeks.\n- Our designer is away for a week.");
  });

  it("drops the frontmatter when the selection starts at the top", async () => {
    const note = fixtureNote("Projects/Apollo launch.md");
    const m = await buildMaterial({ ...note, markdown: note.markdown.slice(0, 120), selection: true, selectionAtStart: true }, fixtureReader, { includeLinked: false });
    expect(m.text).not.toContain("status: active");
    expect(m.text.startsWith("# Goal")).toBe(true);
  });
});
