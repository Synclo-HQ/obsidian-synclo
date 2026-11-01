import { describe, expect, it } from "vitest";
import { SyncloError } from "../src/api/errors";
import { parseGeneration, type Generation } from "../src/api/synclo";
import { parseJobs, progressText, type PendingJob } from "../src/jobs/jobs";
import { JobRunner, type RunnerEvents } from "../src/jobs/runner";

const BASE = "https://synclo.app";
const job = (over: Partial<PendingJob> = {}): PendingJob => ({ generationId: "gen_1", notePath: "Q3.md", title: "Q3 review", format: "slides", base: BASE, startedAt: 0, ...over });
const gen = (x: Record<string, unknown>): Generation => parseGeneration({ id: "gen_1", ...x });

describe("progress in words", () => {
  it("tells the story from planning to written", () => {
    expect(progressText(job(), gen({ status: "queued" })).line).toBe("Waiting for Synclo to start…");
    expect(progressText(job(), gen({ status: "running", progress: null })).line).toBe("Planning the slides…");
    const planned = gen({ status: "running", progress: { step: "writing", title: "Q3 in review", slides: [{ title: "Opening" }, { title: "Results" }, { title: "Risks" }, { title: "Next" }], written: 0, total: 4 } });
    expect(progressText(job(), planned)).toEqual({ title: "Q3 in review", line: "Planned 4 slides: Opening, Results, Risks…", short: "planned 4 slides" });
    const writing = gen({ status: "running", progress: { slides: [], written: 4, total: 9 } });
    expect(progressText(job(), writing).line).toBe("4 of 9 slides written");
    const pictures = gen({ status: "running", progress: { slides: [], written: 9, total: 9, pictures: { made: 3, total: 6 } } });
    expect(progressText(job(), pictures).line).toBe("Adding pictures: 3 of 6");
    expect(progressText(job({ format: "document" }), gen({ status: "running", progress: { slides: [], written: 1, total: 5 } })).line).toBe("1 of 5 sections written");
  });

  it("reads saved jobs defensively", () => {
    expect(parseJobs([job(), { nope: true }, null, "x"])).toEqual([job()]);
    expect(parseJobs(null)).toEqual([]);
  });
});

function runner(answers: Array<Generation | Error | "hang">, options: { signedIn?: () => boolean; now?: () => number; saved?: PendingJob[] } = {}) {
  let saved: PendingJob[] = options.saved ?? [];
  const log: string[] = [];
  const asked: number[] = [];
  let i = 0;
  let readyResolve: () => void = () => undefined;
  const finished = new Promise<void>((r) => (readyResolve = r));
  const events: RunnerEvents = {
    progress: (_j, g) => log.push(`progress:${g.status}`),
    ready: (_j, g) => {
      log.push(`ready:${g.document?.title ?? ""}`);
      readyResolve();
    },
    failed: (_j, e) => {
      log.push(`failed:${e.code}`);
      readyResolve();
    },
    signedOut: () => {
      log.push("signed-out");
      readyResolve();
    },
    trouble: (_j, e) => log.push(`trouble:${e instanceof Error ? e.message : "?"}`),
  };
  const r = new JobRunner({
    generation: (_id, wait) => {
      asked.push(wait);
      const a = answers[Math.min(i++, answers.length - 1)];
      if (a === "hang") return new Promise<Generation>(() => undefined);
      if (a instanceof Error) return Promise.reject(a);
      return Promise.resolve(a as Generation);
    },
    store: { load: () => saved, save: (j) => (saved = [...j]) },
    events,
    timers: { set: (fn) => setTimeout(fn, 0) as unknown as number, clear: (id) => clearTimeout(id) },
    now: options.now ?? (() => 1000),
    base: () => BASE,
    isSignedIn: options.signedIn ?? (() => true),
    waitSeconds: () => 30,
  });
  return { r, log, finished, saved: () => saved, asked };
}

const done = gen({ status: "completed", document: { id: "0b0e7c39-6f4c-4f53-9d5e-0f6d2f1c9a10", title: "Q3 review", slides: 9, edit_url: "https://synclo.app/d/0b0e7c39-6f4c-4f53-9d5e-0f6d2f1c9a10" } });

describe("following a presentation", () => {
  it("reports progress, then ready, and forgets the job", async () => {
    const t = runner([gen({ status: "queued" }), gen({ status: "running" }), done]);
    t.r.add(job());
    expect(t.saved()).toHaveLength(1);
    await t.finished;
    expect(t.log).toEqual(["progress:queued", "progress:running", "ready:Q3 review"]);
    expect(t.saved()).toEqual([]);
    expect(t.asked).toEqual([30, 30, 30]);
  });

  it("keeps trying through a lost connection", async () => {
    const t = runner([new SyncloError("network", "offline"), new SyncloError("unavailable", "busy"), done]);
    t.r.add(job());
    await t.finished;
    expect(t.log.filter((l) => l.startsWith("trouble"))).toHaveLength(2);
    expect(t.log[t.log.length - 1]).toBe("ready:Q3 review");
  });

  it("reports Synclo's reason when it fails", async () => {
    const t = runner([gen({ status: "failed", error: { code: "insufficient_credits", message: "out" } })]);
    t.r.add(job());
    await t.finished;
    expect(t.log).toEqual(["failed:insufficient_credits"]);
    expect(t.saved()).toEqual([]);
  });

  it("waits for the person to connect again, keeping the job", async () => {
    const t = runner([new SyncloError("signed-out", "ended")]);
    t.r.add(job());
    await t.finished;
    expect(t.log).toEqual(["signed-out"]);
    expect(t.saved()).toHaveLength(1);
  });

  it("drops a job Synclo no longer knows", async () => {
    const t = runner([new SyncloError("rejected", "No generation", { code: "not_found" })]);
    t.r.add(job());
    await t.finished;
    expect(t.log).toEqual(["failed:not_found"]);
  });

  it("resumes saved jobs after a restart", async () => {
    const t = runner([done], { saved: [job()] });
    t.r.resumeAll();
    await t.finished;
    expect(t.log).toEqual(["ready:Q3 review"]);
  });

  it("gives up on a check that never answers when Obsidian comes back", async () => {
    let now = 1000;
    const t = runner(["hang", done], { now: () => now });
    t.r.add(job());
    await new Promise((r) => setTimeout(r, 5));
    now += 60_000;
    t.r.kick();
    await t.finished;
    expect(t.asked).toHaveLength(2);
    expect(t.log).toEqual(["ready:Q3 review"]);
  });

  it("gives up on a job after three hours", async () => {
    const t = runner([gen({ status: "running" })], { now: () => 4 * 60 * 60 * 1000 });
    t.r.add(job());
    await t.finished;
    expect(t.log).toEqual(["failed:timed_out"]);
  });

  it("follows a job once even when added twice", async () => {
    const t = runner([gen({ status: "running" }), done]);
    t.r.add(job());
    t.r.add(job());
    await t.finished;
    expect(t.saved()).toEqual([]);
    expect(t.asked).toHaveLength(2);
  });
});
