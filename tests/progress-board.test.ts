import { describe, expect, it } from "vitest";
import { parseCardState } from "../src/api/card";
import { parseGeneration } from "../src/api/synclo";
import { progressInputOf, progressWords } from "../src/jobs/jobs";
import { ProgressBoard, isBehind } from "../src/jobs/progress-board";
import { cardProgressInput, progressShare, shareOf } from "../src/panel/model";

const runnerSays = (x: Record<string, unknown>) => progressInputOf(parseGeneration({ id: "gen_1", ...x }));
const panelSays = (x: Record<string, unknown>) => cardProgressInput(parseCardState({ kind: "generation", status: "running", format: "slides", frames: [], ...x }));
const frames = (n: number, written: number) => Array.from({ length: n }, (_v, i) => ({ t: `Slide ${i + 1}`, s: i < written ? "written" : "planned", pic: null }));

/** What the status bar and the panel's line say, from the board. */
function both(board: ProgressBoard) {
  const input = board.get("gen_1") ?? progressInputOf(null);
  return { bar: `Synclo · ${progressWords(input, "slides", "Field notes").short}`, panel: progressWords(input, "slides", "Field notes", false).line };
}

describe("one word on progress, from whichever answer came last", () => {
  it("lets the panel's newer answer reach the status bar", () => {
    const board = new ProgressBoard();
    board.update("gen_1", runnerSays({ status: "queued" }));
    expect(both(board)).toEqual({ bar: "Synclo · waiting to start", panel: "Waiting for Synclo to start…" });
    board.update("gen_1", panelSays({ frames: frames(4, 0), step: "writing" }));
    expect(both(board)).toEqual({ bar: "Synclo · planned 4 slides", panel: "Planned 4 slides" });
  });

  it("lets the job runner's newer answer reach the panel", () => {
    const board = new ProgressBoard();
    board.update("gen_1", panelSays({ frames: frames(4, 1) }));
    board.update("gen_1", runnerSays({ status: "running", progress: { step: "writing", slides: frames(4, 3).map((f) => ({ title: f.t, written: f.s === "written" })), written: 3, total: 4 } }));
    expect(both(board)).toEqual({ bar: "Synclo · 3 of 4 slides", panel: "3 of 4 slides written" });
  });

  it("doesn't step back when the two answers cross", () => {
    const board = new ProgressBoard();
    board.update("gen_1", panelSays({ frames: frames(4, 3) }));
    board.update("gen_1", runnerSays({ status: "running", progress: { slides: [], written: 2, total: 4 } }));
    expect(both(board).panel).toBe("3 of 4 slides written");
    board.update("gen_1", runnerSays({ status: "completed" }));
    board.update("gen_1", panelSays({ frames: frames(4, 4), pictures: { made: 1, total: 3 } }));
    expect(board.get("gen_1")?.status).toBe("completed");
  });

  it("says when it changed, and only then", () => {
    const board = new ProgressBoard();
    const heard: string[] = [];
    board.onChange((id) => heard.push(id));
    board.update("gen_1", panelSays({ frames: frames(4, 1) }));
    board.update("gen_1", panelSays({ frames: frames(4, 1) }));
    board.update("gen_1", panelSays({ frames: frames(4, 2) }));
    expect(heard).toEqual(["gen_1", "gen_1"]);
  });

  it("orders answers by how far they say it has got", () => {
    const planned = panelSays({ frames: frames(4, 0) });
    expect(isBehind(runnerSays({ status: "queued" }), planned)).toBe(true);
    expect(isBehind(panelSays({}), planned)).toBe(true);
    expect(isBehind(panelSays({ frames: frames(4, 1) }), planned)).toBe(false);
    expect(isBehind(panelSays({ frames: frames(4, 4), pictures: { made: 1, total: 3 } }), panelSays({ frames: frames(4, 4), pictures: { made: 2, total: 3 } }))).toBe(true);
  });

  it("fills the bar the same from either answer", () => {
    const card = parseCardState({ kind: "generation", status: "running", frames: frames(10, 10), pictures: { made: 3, total: 6 } });
    const gen = runnerSays({ status: "running", progress: { slides: [], written: 10, total: 10, pictures: { made: 3, total: 6 } } });
    expect(shareOf(gen)).toBeCloseTo(progressShare(card) ?? -1);
  });
});

describe("Synclo's own step names", () => {
  const base = { status: "running" as const, title: null, started: true, total: 0, written: 0, slideTitles: [], pictures: null };
  it("reads any step before the slides are planned as planning, never as starting", () => {
    for (const step of ["directing", "designing", "planning", null]) {
      expect(progressWords({ ...base, step }, "slides", "Field notes", false).line).toBe("Planning the slides…");
    }
  });
  it("reads Synclo's review step as checking", () => {
    expect(progressWords({ ...base, step: "reviewing", total: 4, written: 4 }, "slides", "Field notes", false).line).toBe("Checking every slide…");
  });
});
