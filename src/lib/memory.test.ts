import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { claimRun, runGeneration, type RunEvent } from "./generator/run";
import { listMemories, memoryContext, remember } from "./memory";
import type { ResolvedModel } from "./models";
import { createProject, type Project } from "./projects";
import { listFiles, workspaceDir, writeFile } from "./workspace";

const REAL_CLI = path.join(os.homedir(), ".config", "vessel", "toolchains", "provena", "cli", "dist", "cli.js");

let dir: string;
let project: Project;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "vessel-memory-"));
  process.env.VESSEL_HOME = dir;
  project = await createProject({ kind: "app", brief: "A support desk" });
});
afterEach(async () => {
  delete process.env.VESSEL_HOME;
  delete process.env.VESSEL_PROVENA_CLI;
  await fs.rm(dir, { recursive: true, force: true });
});

const event = (o: Record<string, unknown>) => JSON.stringify({ status: "active", tags: [], created_at: "2026-10-01T00:00:00Z", ...o });
async function writeLedger(root: string, lines: string[]) {
  await fs.mkdir(path.join(root, ".provena", "memory"), { recursive: true });
  await fs.writeFile(path.join(root, ".provena", "memory", "events.jsonl"), lines.join("\n") + "\n{torn");
}

describe("memory ledger", () => {
  it("lists explicit memories only, latest version per id, newest first, across project and user brains", async () => {
    await writeLedger(workspaceDir(project.id), [
      event({ id: "m1", kind: "decision", title: "Soft delete", body: "old", authority: "agent", created_at: "2026-10-02T00:00:00Z" }),
      event({ id: "m1", kind: "decision", title: "Soft delete", body: "Never DELETE rows.", authority: "agent", created_at: "2026-10-02T00:00:00Z" }),
      event({ id: "m2", kind: "fact", title: "Observed package", body: "x", tags: ["provena:managed:repo-map"] }),
      event({ id: "m3", kind: "preference", title: "Gone", body: "x", status: "superseded" }),
    ]);
    await writeLedger(path.join(dir, "brain"), [event({ id: "u1", kind: "preference", title: "Indigo accents", body: "Likes indigo.", authority: "human" })]);

    const all = await listMemories(project.id);
    expect(all.map((m) => [m.id, m.scope, m.body])).toEqual([
      ["m1", "project", "Never DELETE rows."],
      ["u1", "user", "Likes indigo."],
    ]);
    // Rules the user set come first in the prompt.
    expect((await memoryContext(project.id)).split("\n")).toEqual([
      "- [preference, all projects, set by the user] Indigo accents: Likes indigo.",
      "- [decision] Soft delete: Never DELETE rows.",
    ]);
  });

  it("is empty, not an error, when nothing was remembered or Provena is missing", async () => {
    expect(await memoryContext(project.id)).toBe("");
    process.env.VESSEL_PROVENA_CLI = path.join(dir, "missing.js");
    await expect(remember(project.id, [{ kind: "fact", scope: "project", title: "t", body: "b", authority: "agent" }])).resolves.toBeUndefined();
  });
});

function mockModel(text: string) {
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start" as const, warnings: [] },
          { type: "text-start" as const, id: "t" },
          ...[...text].map((delta) => ({ type: "text-delta" as const, id: "t", delta })),
          { type: "text-end" as const, id: "t" },
          { type: "finish" as const, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, finishReason: { unified: "stop" as const, raw: "stop" } },
        ],
      }),
    }),
  });
  return { model, resolved: { provider: "openai", modelId: "mock-model", model } as ResolvedModel };
}

describe("memory in a run", () => {
  it("recalls memories into the prompt and reports the ones the model records", async () => {
    await writeLedger(workspaceDir(project.id), [event({ id: "m1", kind: "decision", title: "Soft delete", body: "Never DELETE rows.", authority: "human" })]);
    const { model, resolved } = mockModel('Added.\n<file path="server.js">x\n</file>\n<memory kind="invariant" scope="project" title="Tickets keep history">Status changes append to ticket_events.</memory>');
    const events: RunEvent[] = [];
    for await (const e of runGeneration({ project, message: "add history", resolved, controller: claimRun(project.id)! })) events.push(e);

    const prompt = JSON.stringify(model.doStreamCalls.at(-1)!.prompt);
    expect(prompt).toContain("PROJECT MEMORY");
    expect(prompt).toContain("Soft delete: Never DELETE rows.");
    expect(prompt).toContain("<memory kind=");
    expect(events).toContainEqual({ type: "memory", kind: "invariant", scope: "project", title: "Tickets keep history" });
    expect((await listFiles(project.id)).map((f) => f.path)).toEqual(["server.js"]); // .provena stays out of the workspace view
  });
});

describe.skipIf(!existsSync(REAL_CLI))("with the Provena CLI", () => {
  it("creates a hook-free brain, stores project and user memories, and reads them back", async () => {
    process.env.VESSEL_PROVENA_CLI = REAL_CLI;
    await writeFile(project.id, "server.js", "console.log(1);\n");
    await remember(project.id, [
      { kind: "decision", scope: "project", title: "Original brief", body: "A support desk", authority: "human" },
      { kind: "preference", scope: "user", title: "Rounded UI", body: "Prefers soft, rounded light UIs.", authority: "agent" },
    ]);
    const all = await listMemories(project.id);
    expect(all.map((m) => [m.scope, m.kind, m.title, m.authority])).toEqual(
      expect.arrayContaining([
        ["project", "decision", "Original brief", "human"],
        ["user", "preference", "Rounded UI", "agent"],
      ]),
    );
    const gitConfig = await fs.readFile(path.join(workspaceDir(project.id), ".git", "config"), "utf8");
    expect(gitConfig).toMatch(/hooksPath = .*no-hooks/);
    expect(existsSync(path.join(workspaceDir(project.id), ".provena", "repo.brain.md"))).toBe(true);
    // Only Provena's managed .gitignore block shows up next to the user's files; the brain itself stays hidden.
    expect((await listFiles(project.id)).map((f) => f.path)).toEqual([".gitignore", "server.js"]);
    expect(await fs.readFile(path.join(workspaceDir(project.id), ".gitignore"), "utf8")).toContain("provena local state");
  }, 120_000);
});
