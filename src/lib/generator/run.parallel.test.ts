import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ResolvedModel } from "../models";
import { createProject, type Project } from "../projects";
import { readFile } from "../workspace";
import { readChat } from "./history";
import { parsePlan } from "./plan";
import { claimRun, fanOut, runGeneration, stopRun, type RunEvent } from "./run";

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 42, text: 42, reasoning: 0 } };

const PLAN = {
  summary: "A support desk with a ticket API and a one-page UI.",
  files: [
    { path: "server.js", purpose: "Express API and static hosting" },
    { path: "public/app.js", purpose: "fetches and renders tickets" },
    { path: "public/index.html", purpose: "page shell" },
    { path: "package.json", purpose: "dependencies" },
    { path: "README.md", purpose: "how to run" },
  ],
  contracts: { routes: [{ method: "GET", path: "/api/tickets", response: "200 Ticket[]" }], dom: ["#tickets"] },
};
const fileBlock = (p: string) => `<file path="${p}">\n// ${p}\n</file>`;

/** A model that answers the plan call with `plan` and each per-file call with `file(path)`, in small delayed chunks. */
function routedModel({
  plan = JSON.stringify(PLAN),
  file = fileBlock,
  delayMs = null,
  planError,
  hang,
}: { plan?: string; file?: (p: string) => string; delayMs?: number | null; planError?: boolean; hang?: (p: string | undefined, n: number) => boolean } = {}) {
  const state = { inflight: 0, maxInflight: 0, fileSignals: [] as AbortSignal[], filePaths: [] as string[] };
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      const assigned = JSON.stringify(options.prompt).match(/WRITE THIS FILE: (.+?)\\n/)?.[1];
      const text = assigned ? file(assigned) : plan;
      const chunks = text.match(/[\s\S]{1,12}/g) ?? [];
      const parts = [
        { type: "stream-start" as const, warnings: [] },
        { type: "text-start" as const, id: "t" },
        ...chunks.map((delta) => ({ type: "text-delta" as const, id: "t", delta })),
        { type: "text-end" as const, id: "t" },
        ...(planError && !assigned
          ? [{ type: "error" as const, error: new Error("quota exceeded for Bearer abcdefghijkl") }]
          : [{ type: "finish" as const, usage, finishReason: { unified: "stop" as const, raw: "stop" } }]),
      ];
      if (assigned) {
        state.filePaths.push(assigned);
        if (options.abortSignal) state.fileSignals.push(options.abortSignal);
        state.inflight++;
        state.maxInflight = Math.max(state.maxInflight, state.inflight);
      }
      const n = state.filePaths.filter((p) => p === assigned).length;
      // A connection that sends a little and then never closes, ignoring abort, like a dead socket.
      if (hang?.(assigned, n)) return { stream: new ReadableStream({ start: (c) => parts.slice(0, 3).forEach((p) => c.enqueue(p)) }) };
      const done = new TransformStream({ flush: () => void (assigned && state.inflight--) });
      return { stream: simulateReadableStream({ chunks: parts, chunkDelayInMs: delayMs }).pipeThrough(done) };
    },
  });
  return { model, state, resolved: { provider: "openai", modelId: "mock-model", model } as ResolvedModel };
}

async function collect(gen: AsyncGenerator<RunEvent>, onEvent?: (e: RunEvent) => void) {
  const out: RunEvent[] = [];
  for await (const e of gen) {
    out.push(e);
    onEvent?.(e);
  }
  return out;
}
const of = <T extends RunEvent["type"]>(events: RunEvent[], type: T) => events.filter((e): e is Extract<RunEvent, { type: T }> => e.type === type);
const endOf = (events: RunEvent[]) => events.at(-1) as Extract<RunEvent, { type: "run-end" }>;

let dir: string;
let project: Project;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "vessel-par-"));
  process.env.VESSEL_HOME = dir;
  project = await createProject({ kind: "app", brief: "A support desk" });
});
afterEach(async () => {
  delete process.env.VESSEL_HOME;
  delete process.env.GENERATION_CONCURRENCY;
  delete process.env.GENERATION_STALL_SECONDS;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("parallel first generation", () => {
  it("plans, then writes every planned file from its own call, with summed metrics", async () => {
    const { model, resolved } = routedModel();
    const events = await collect(runGeneration({ project, message: "support desk", resolved, controller: claimRun(project.id)! }));

    expect(of(events, "stage").map((e) => e.stage)).toEqual(["plan", "generate"]);
    expect(of(events, "file-written").map((e) => e.path).sort()).toEqual(PLAN.files.map((f) => f.path).sort());
    expect(await readFile(project.id, "public/app.js")).toBe("// public/app.js\n");

    const end = endOf(events);
    expect(end).toMatchObject({ status: "succeeded", mode: "parallel", calls: 6, outputTokens: 42 * 6 });
    expect(end.planMs).toEqual(expect.any(Number));
    expect(end.firstFileMs).toEqual(expect.any(Number));
    expect(Object.keys(end.fileMs!).sort()).toEqual(PLAN.files.map((f) => f.path).sort());

    // The plan call asks for JSON; each file call carries the full plan and exactly one assignment.
    expect(JSON.stringify(model.doStreamCalls[0].prompt)).toContain("reply with ONE JSON object");
    const fileCall = JSON.stringify(model.doStreamCalls[1].prompt);
    expect(fileCall).toContain("/api/tickets");
    expect(fileCall.match(/WRITE THIS FILE/g)).toHaveLength(1);

    const chat = await readChat(project.id);
    expect(chat[1]).toMatchObject({ status: "succeeded", text: expect.stringContaining("A support desk with a ticket API"), metrics: { mode: "parallel", calls: 6 } });
  });

  it("respects GENERATION_CONCURRENCY", async () => {
    process.env.GENERATION_CONCURRENCY = "2";
    const { state, resolved } = routedModel({ delayMs: 2 });
    const events = await collect(runGeneration({ project, message: "x", resolved, controller: claimRun(project.id)! }));
    expect(endOf(events).status).toBe("succeeded");
    expect(state.filePaths).toHaveLength(5);
    expect(state.maxInflight).toBe(2);
  });

  it("ignores narration and any block outside the assigned path", async () => {
    const { resolved } = routedModel({
      file: (p) =>
        p === "server.js"
          ? `Sure! Here it is.\n${fileBlock(p)}\n<file path="public/app.js">hijacked</file>\n<file path="../evil.js">x</file>\n<delete path="README.md" />`
          : fileBlock(p),
    });
    const events = await collect(runGeneration({ project, message: "x", resolved, controller: claimRun(project.id)! }));
    expect(await readFile(project.id, "public/app.js")).toBe("// public/app.js\n");
    expect(await readFile(project.id, "README.md")).toBe("// README.md\n");
    expect(of(events, "file-written").filter((e) => e.path === "public/app.js")).toHaveLength(1);
    expect(of(events, "file-rejected")).toEqual([]);
    expect(of(events, "file-deleted")).toEqual([]);
    expect(of(events, "text").map((e) => e.text).join("")).not.toContain("Sure!");
  });

  it("reports a planned file the model never wrote", async () => {
    const { resolved } = routedModel({ file: (p) => (p === "README.md" ? "I'd rather not." : fileBlock(p)) });
    const events = await collect(runGeneration({ project, message: "x", resolved, controller: claimRun(project.id)! }));
    expect(of(events, "file-rejected")).toEqual([{ type: "file-rejected", path: "README.md", reason: "the model did not write this file" }]);
    expect(endOf(events).files).toHaveLength(4);
  });

  it("Stop cancels every in-flight call and starts no new ones", async () => {
    const { state, resolved } = routedModel({ delayMs: 5, file: (p) => `<file path="${p}">\n${"x".repeat(2000)}\n</file>` });
    const controller = claimRun(project.id)!;
    const events = await collect(runGeneration({ project, message: "x", resolved, controller }), (e) => {
      if (e.type === "file-start") stopRun(project.id);
    });
    expect(endOf(events).status).toBe("cancelled");
    expect(state.filePaths).toHaveLength(4); // the default limit; the fifth never started
    expect(state.fileSignals.every((s) => s.aborted)).toBe(true);
    expect(of(events, "file-written")).toEqual([]);
    expect(claimRun(project.id)).not.toBeNull();
  });

  it("retries a per-file call that stalls, without waiting on the dead connection", async () => {
    process.env.GENERATION_STALL_SECONDS = "0.05";
    const { state, resolved } = routedModel({ hang: (p, n) => p === "server.js" && n === 1 });
    const events = await collect(runGeneration({ project, message: "x", resolved, controller: claimRun(project.id)! }));
    expect(endOf(events)).toMatchObject({ status: "succeeded", calls: 7 });
    expect(state.filePaths.filter((p) => p === "server.js")).toHaveLength(2);
    expect(of(events, "file-rejected")).toEqual([{ type: "file-rejected", path: "server.js", reason: "the model stopped responding for 0.05s" }]);
    expect(await readFile(project.id, "server.js")).toBe("// server.js\n");
  });

  it("fails the run when a file stalls twice or the plan stalls", async () => {
    process.env.GENERATION_STALL_SECONDS = "0.05";
    const twice = endOf(await collect(runGeneration({ project, message: "x", resolved: routedModel({ hang: (p) => p === "README.md" }).resolved, controller: claimRun(project.id)! })));
    expect(twice).toMatchObject({ status: "failed", error: "README.md: the model stopped responding for 0.05s" });
    expect(twice.files).toHaveLength(4);

    const other = await createProject({ kind: "app", brief: "A second desk" });
    const plan = endOf(await collect(runGeneration({ project: other, message: "x", resolved: routedModel({ hang: (p) => !p }).resolved, controller: claimRun(other.id)! })));
    expect(plan).toMatchObject({ status: "failed", error: "the model stopped responding for 0.05s", calls: 1 });
  });

  it("Stop ends the run even when the connection ignores abort", async () => {
    const { resolved } = routedModel({ hang: (p) => p === "server.js" });
    const controller = claimRun(project.id)!;
    setTimeout(() => stopRun(project.id), 50);
    const events = await collect(runGeneration({ project, message: "x", resolved, controller }));
    expect(endOf(events).status).toBe("cancelled");
  });

  it("fails without a fallback when the plan call itself errors, redacting keys", async () => {
    const { model, resolved } = routedModel({ planError: true });
    const end = endOf(await collect(runGeneration({ project, message: "x", resolved, controller: claimRun(project.id)! })));
    expect(end).toMatchObject({ status: "failed", calls: 1 });
    expect(end.error).toContain("quota exceeded");
    expect(end.error).not.toContain("abcdefghijkl");
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it("GENERATION_CONCURRENCY=0 skips planning", async () => {
    process.env.GENERATION_CONCURRENCY = "0";
    const { model, resolved } = routedModel({ plan: fileBlock("server.js") });
    const events = await collect(runGeneration({ project, message: "x", resolved, controller: claimRun(project.id)! }));
    expect(endOf(events)).toMatchObject({ mode: "single", calls: 1, planMs: null });
    expect(of(events, "file-written").map((e) => e.path)).toEqual(["server.js"]);
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it("falls back to one pass when the plan is invalid", async () => {
    const { model, resolved } = routedModel({ plan: '{"summary":"x","files":[]}' });
    const events = await collect(runGeneration({ project, message: "x", resolved, controller: claimRun(project.id)! }));
    expect(endOf(events)).toMatchObject({ mode: "single", calls: 2 });
    expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain("Then emit every file");
  });
});

describe("parsePlan", () => {
  it("accepts fenced JSON and normalizes paths", () => {
    const parsed = parsePlan("```json\n" + JSON.stringify({ ...PLAN, files: [{ path: "./server.js", purpose: "api" }] }) + "\n```");
    expect(parsed).toMatchObject({ ok: true, plan: { files: [{ path: "server.js" }], contracts: { tables: [], env: [] } } });
  });

  it.each([
    ["not json at all", "no JSON object"],
    ["{ nope }", "not valid JSON"],
    [JSON.stringify({ summary: "x", files: [] }), "files"],
    [JSON.stringify({ summary: "x", files: [{ path: "../x.js", purpose: "p" }] }), "escapes the workspace"],
    [JSON.stringify({ summary: "x", files: [{ path: ".env", purpose: "p" }] }), "unsafe path .env"],
    [JSON.stringify({ summary: "x", files: [{ path: "a.js", purpose: "p" }, { path: "./a.js", purpose: "q" }] }), "twice"],
  ])("rejects %s", (text, reason) => {
    const parsed = parsePlan(text);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.reason).toContain(reason);
  });
});

it("fanOut runs at most `limit` jobs at once and yields everything", async () => {
  let now = 0;
  let max = 0;
  const job = (i: number) =>
    async function* () {
      max = Math.max(max, ++now);
      await new Promise((r) => setTimeout(r, 2));
      yield i;
      now--;
    };
  const out: number[] = [];
  for await (const v of fanOut([0, 1, 2, 3, 4, 5, 6].map(job), 3)) out.push(v);
  expect(out.sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
  expect(max).toBe(3);
});
