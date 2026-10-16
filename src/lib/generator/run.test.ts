import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ResolvedModel } from "../models";
import { createProject, type Project } from "../projects";
import { listFiles, readFile } from "../workspace";
import { readChat, readRunEvents } from "./history";
import { claimRun, historyMessages, runGeneration, stopRun, type RunEvent } from "./run";

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 42, text: 42, reasoning: 0 } };

function mockModel(chunks: string[], { failAfter }: { failAfter?: number } = {}) {
  const parts = [
    { type: "stream-start" as const, warnings: [] },
    { type: "text-start" as const, id: "t" },
    ...chunks.map((delta) => ({ type: "text-delta" as const, id: "t", delta })),
    { type: "text-end" as const, id: "t" },
    { type: "finish" as const, usage, finishReason: { unified: "stop" as const, raw: "stop" } },
  ];
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream:
        failAfter === undefined
          ? simulateReadableStream({ chunks: parts })
          : simulateReadableStream({ chunks: [...parts.slice(0, failAfter), { type: "error" as const, error: new Error("upstream exploded sk-secretkey123456") }] }),
    }),
  });
  return { model, resolved: { provider: "openai", modelId: "mock-model", model } as ResolvedModel };
}

async function collect(gen: AsyncGenerator<RunEvent>) {
  const out: RunEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

let dir: string;
let project: Project;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "vessel-run-"));
  process.env.VESSEL_HOME = dir;
  project = await createProject({ kind: "app", brief: "A support desk" });
});
afterEach(async () => {
  delete process.env.VESSEL_HOME;
  await fs.rm(dir, { recursive: true, force: true });
});

const OUTPUT = ['Building a tiny API.\n<file path="server.js">\nconsole.log(1)', ';\n</file>\n<file path="../evil.js">x\n</file>\n', '<file path="public/index.html">\n<h1>Hi</h1>\n</file>\nDone.'];

describe("runGeneration", () => {
  it("streams narration, writes valid files, rejects unsafe ones and records history", async () => {
    const { resolved, model } = mockModel(OUTPUT);
    const events = await collect(runGeneration({ project, message: "build it", resolved, controller: claimRun(project.id)! }));

    expect(events[0]).toMatchObject({ type: "run-start", model: "mock-model" });
    expect(events.filter((e) => e.type === "stage").map((e) => (e as { stage: string }).stage)).toEqual(["plan", "generate"]);
    expect(events.filter((e) => e.type === "file-written").map((e) => (e as { path: string }).path)).toEqual(["server.js", "public/index.html"]);
    expect(events).toContainEqual({ type: "file-rejected", path: "../evil.js", reason: "path escapes the workspace" });

    const end = events.at(-1) as Extract<RunEvent, { type: "run-end" }>;
    // The reply is not a plan, so the run fell back to one pass: two calls, tokens summed across both.
    expect(end).toMatchObject({ type: "run-end", status: "succeeded", outputTokens: 84, mode: "single", calls: 2 });
    expect(end.files.map((f) => f.path)).toEqual(["server.js", "public/index.html"]);

    expect(await readFile(project.id, "server.js")).toBe("console.log(1);\n");
    expect((await listFiles(project.id)).map((f) => f.path)).toEqual(["public/index.html", "server.js"]);

    const chat = await readChat(project.id);
    expect(chat.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(chat[1]).toMatchObject({ status: "succeeded", text: expect.stringContaining("Building a tiny API.") });
    const logged = (await readRunEvents(project.id, end.runId)).map((e) => (e as { type: string }).type);
    expect(logged).toContain("file-written");
    expect(logged).toContain("plan-fallback");

    // The single pass got the kind's instructions and no file snapshot on the first turn.
    const call = model.doStreamCalls[1];
    expect(JSON.stringify(call.prompt)).toContain("YOU ARE BUILDING: a full-stack web app");
    expect(JSON.stringify(call.prompt)).not.toContain("CURRENT PROJECT FILES");
  });

  it("sends the current files on follow-ups so the model edits instead of rewriting", async () => {
    await collect(runGeneration({ project, message: "build it", resolved: mockModel(OUTPUT).resolved, controller: claimRun(project.id)! }));
    const second = mockModel(["Renamed.\n", '<delete path="public/index.html" />']);
    const events = await collect(runGeneration({ project, message: "remove the page", resolved: second.resolved, controller: claimRun(project.id)! }));
    expect(events).toContainEqual({ type: "file-deleted", path: "public/index.html" });
    const prompt = JSON.stringify(second.model.doStreamCalls[0].prompt);
    expect(prompt).toContain("CURRENT PROJECT FILES");
    expect(prompt).toContain("console.log(1);");
    expect(prompt).toContain("write server.js"); // history summary of the previous turn
  });

  it("reports provider errors without leaking keys, and keeps files already written", async () => {
    const { resolved } = mockModel(OUTPUT, { failAfter: 3 }); // after the first chunk, with server.js still open
    const events = await collect(runGeneration({ project, message: "build it", resolved, controller: claimRun(project.id)! }));
    const end = events.at(-1) as Extract<RunEvent, { type: "run-end" }>;
    expect(end.status).toBe("failed");
    expect(end.error).toContain("upstream exploded");
    expect(end.error).not.toContain("secretkey123456");
    expect(events.some((e) => e.type === "file-written")).toBe(false); // the open file was cut off, so nothing was written
  });

  it("allows one run per project and supports stopping", async () => {
    const controller = claimRun(project.id)!;
    expect(claimRun(project.id)).toBeNull();
    expect(stopRun(project.id)).toBe(true);
    const events = await collect(runGeneration({ project, message: "x", resolved: mockModel(OUTPUT).resolved, controller }));
    expect((events.at(-1) as { status: string }).status).toBe("cancelled");
    expect(claimRun(project.id)).not.toBeNull(); // released after the run
  });
});

it("turns chat history into compact model messages", () => {
  expect(
    historyMessages([
      { role: "user", text: "make a todo app", at: "t" },
      { role: "assistant", text: "Done.", at: "t", files: [{ path: "server.js", bytes: 10, op: "write" }] },
    ]),
  ).toEqual([
    { role: "user", content: "make a todo app" },
    { role: "assistant", content: "Done.\n(Files changed: write server.js)" },
  ]);
});

it("collapses the blank lines left between narration and file blocks", async () => {
  const { tidyNarration } = await import("./run");
  expect(tidyNarration("Intro.\n\n\n\n  \nDone.  \n")).toBe("Intro.\n\nDone.");
});
