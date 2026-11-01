import { describe, expect, it } from "vitest";
import { cleanMarkdown } from "../src/material/clean";
import { frontmatterTitle, isDrawingFrontmatter, splitFrontmatter } from "../src/material/frontmatter";
import { LeftOut, describeLeftOut } from "../src/material/left-out";
import { altFromFileName, embedAlt, linkDisplay, parseWikiInner } from "../src/material/links";
import { drawingText, sliceBySubpath } from "../src/material/slice";
import { readableWordCount, serverWordCount } from "../src/material/words";
import { joinRelative } from "../src/util/paths";

function clean(md: string) {
  const leftOut = new LeftOut();
  let n = 0;
  const res = cleanMarkdown(md, { sourcePath: "Note.md", leftOut, nextEmbed: () => ++n });
  return { ...res, leftOut, said: describeLeftOut(leftOut) };
}

describe("tags", () => {
  it("removes tags and keeps things that only look like them", () => {
    expect(clean("Ship it #launch #team/web today").text).toBe("Ship it today");
    expect(clean("#inbox").text).toBe("");
    expect(clean("See issue #1984, C# code, a#b and https://x.com/#top").text).toBe("See issue #1984, C# code, a#b and https://x.com/#top");
    expect(clean("# Heading #draft").text).toBe("# Heading");
    expect(clean("`#kept`#tag").text).toBe("`#kept`#tag");
  });
});

describe("comments", () => {
  it("removes an inline comment with a percent sign in it", () => {
    expect(clean("Growth %%was 5% before%% is 9%.").text).toBe("Growth is 9%.");
  });

  it("removes a comment opened mid-line and closed lines later, keeping what follows", () => {
    expect(clean("- one %% hidden\nstill hidden\nend %% two\n- three").text).toBe("- one\ntwo\n- three");
  });

  it("keeps comment marks inside code spans and fences", () => {
    expect(clean("Use `%%` and `<!-- -->` to hide text.").text).toBe("Use `%%` and `<!-- -->` to hide text.");
    expect(clean("```\n%% not a comment %%\n```").text).toBe("```\n%% not a comment %%\n```");
    expect(clean("~~~~\n```\n%%x%%\n```\n~~~~").text).toBe("~~~~\n```\n%%x%%\n```\n~~~~");
  });

  it("counts comments once as private comments", () => {
    const r = clean("a %%b%% c\n\n<!-- d -->\n\n%%\ne\n%%");
    expect(r.text).toBe("a c");
    expect(r.said).toBe("private comments");
  });

  it("removes a comment inside a quote and keeps the quote whole", () => {
    expect(clean("> first\n> %% hidden %%\n> second").text).toBe("> first\n>\n> second");
  });
});

describe("links", () => {
  it("reads wikilinks as their alias or note name", () => {
    expect(clean("See [[Plan]], [[Plan|the plan]], [[Plan#Budget]], [[Plan#^abc]], [[#Risks]] and [[folder/Plan.md]].").text).toBe("See Plan, the plan, Plan › Budget, Plan, Risks and Plan.");
    expect(clean("| [[Plan\\|P]] | x |").text).toBe("| P | x |");
  });

  it("collects the notes linked to", () => {
    expect(clean("[[A]] [[b/B|x]] [c](C%20note.md) [web](https://x.com) [[#Here]]").links).toEqual(["A", "b/B", "C note.md"]);
  });

  it("keeps web links and reads note links as their words", () => {
    expect(clean("[docs](https://example.com/a(b)) and [the plan](Plan.md) and [x](obsidian://open?vault=v)").text).toBe("[docs](https://example.com/a(b)) and the plan and x");
  });

  it("parses link parts", () => {
    expect(parseWikiInner("Note#H1#H2|Alias")).toEqual({ path: "Note", subpath: "#H1#H2", alias: "Alias" });
    expect(linkDisplay(parseWikiInner("Note#H1#H2"))).toBe("Note › H1 › H2");
    expect(embedAlt("300")).toBe("");
    expect(embedAlt("The team|300")).toBe("The team");
    expect(altFromFileName("Pasted image 20261031101500")).toBe("");
    expect(altFromFileName("IMG_2041")).toBe("");
    expect(altFromFileName("q3-revenue_chart")).toBe("q3 revenue chart");
  });
});

describe("marks and blocks", () => {
  it("bolds highlights and leaves equations alone", () => {
    expect(clean("A ==big== win; a == b stays").text).toBe("A **big** win; a == b stays");
    expect(clean("$$x %% y$$").text).toBe("$$x %% y$$");
  });

  it("removes block ids and keeps hard line breaks", () => {
    expect(clean("- item ^abc-1\nline one  \nline two").text).toBe("- item\nline one  \nline two");
  });

  it("turns an underlined heading into a heading only under a paragraph", () => {
    expect(clean("Title\n---\ntext").text).toBe("## Title\ntext");
    expect(clean("- item\n---\nafter").text).toBe("- item\n\n---\n\nafter");
  });

  it("reads Dataview fields as words", () => {
    expect(clean("Due:: Friday\n- [ ] Owner:: Ana\nSee [kind:: memo] (score:: 9) std::vector").text).toBe("Due: Friday\n- [ ] Owner: Ana\nSee kind: memo 9 std::vector");
  });

  it("leaves Dataview's inline queries out", () => {
    const r = clean("Total: `= this.total` pages.");
    expect(r.text).toBe("Total: pages.");
    expect(r.said).toBe("1 Dataview query");
  });

  it("titles a callout and keeps its body", () => {
    expect(clean("> [!faq]- Why now?\n> Because.").text).toBe("> **Why now?**\n> Because.");
    expect(clean("> [!my-custom_type]\n> x").text).toBe("> **My custom type**\n> x");
  });
});

describe("sections of a note", () => {
  const body = "# A\nintro\n## B\nb text\n### C\nc text\n## D\nd text ^blk\n\n- item one ^li\n  - child\n- item two\n\n| t |\n| - |\n^tbl";

  it("slices a heading's section, nested headings and blocks", () => {
    expect(sliceBySubpath(body, "#B")).toBe("## B\nb text\n### C\nc text");
    expect(sliceBySubpath(body, "#A#D")).toBe("## D\nd text ^blk\n\n- item one ^li\n  - child\n- item two\n\n| t |\n| - |\n^tbl");
    expect(sliceBySubpath(body, "#^blk")).toBe("d text ^blk");
    expect(sliceBySubpath(body, "#^li")).toBe("- item one ^li\n  - child");
    expect(sliceBySubpath(body, "#^tbl")).toBe("| t |\n| - |");
    expect(sliceBySubpath(body, "#Nope")).toBeNull();
    expect(sliceBySubpath("# Plan with [[Ana]]\nx", "#Plan with Ana")).toBe("# Plan with [[Ana]]\nx");
  });

  it("ignores headings inside code", () => {
    expect(sliceBySubpath("```\n# not\n```\n# Yes\nok", "#not")).toBeNull();
  });
});

describe("frontmatter", () => {
  it("splits it off only when it is closed", () => {
    expect(splitFrontmatter("---\na: 1\n---\nbody")).toEqual({ frontmatter: "a: 1", body: "body" });
    expect(splitFrontmatter("---\nnot closed\nbody").frontmatter).toBeNull();
    expect(splitFrontmatter("﻿---\r\na: 1\r\n---\r\nbody").body).toBe("body");
  });

  it("reads a one-line title", () => {
    expect(frontmatterTitle('title: "Q3: the review"')).toBe("Q3: the review");
    expect(frontmatterTitle("Title: Plain")).toBe("Plain");
    expect(frontmatterTitle("title: >\n  folded")).toBeNull();
    expect(isDrawingFrontmatter("excalidraw-plugin: parsed")).toBe(true);
  });
});

describe("drawings", () => {
  it("keeps the prose and labels, never the data", () => {
    const d = "Notes about it\n\n# Excalidraw Data\n## Text Elements\nLabel one ^abcdefgh\n\nLabel two ^ijklmnop\n%%\n## Drawing\n```json\n{}\n```\n%%";
    expect(drawingText(d)).toBe("Notes about it\n\nLabel one\nLabel two");
  });

  it("reads a plain .excalidraw file's text elements", () => {
    const json = JSON.stringify({ type: "excalidraw", elements: [{ type: "rectangle" }, { type: "text", text: "Inbox" }, { type: "text", text: "Gone", isDeleted: true }, { type: "text", text: " Done " }] });
    expect(drawingText(json)).toBe("Inbox\nDone");
    expect(drawingText("{ not json")).toBe("");
  });
});

describe("words", () => {
  it("counts the way Synclo counts", () => {
    expect(serverWordCount("# Title\n\n- one two")).toBe(5);
    expect(serverWordCount("   ")).toBe(0);
    // Scripts without spaces count about a word for every two characters,
    // as Synclo counts them (a Chinese page is notes, not a one-word brief).
    expect(serverWordCount("我们今年第一季度的收入增长了百分之十二，主要是因为续约翻了一番。")).toBe(17);
    expect(serverWordCount("Mixed 中文 text here 一二三四")).toBe(6);
  });

  it("counts words people read, without addresses", () => {
    expect(readableWordCount("Hello world ![a picture](https://x.com/a.png) [link](https://x.com)")).toBe(3);
  });
});

describe("paths", () => {
  it("resolves relative paths", () => {
    expect(joinRelative("notes/q3", "../img/a.png")).toBe("notes/img/a.png");
    expect(joinRelative("", "./a.png")).toBe("a.png");
    expect(joinRelative("a/b", "../../../c.png")).toBe("c.png");
  });
});
