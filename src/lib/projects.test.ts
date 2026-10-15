import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createProject, getProject, listProjects, nameFromBrief } from "./projects";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "vessel-projects-"));
  process.env.VESSEL_HOME = dir;
});
afterEach(async () => {
  delete process.env.VESSEL_HOME;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("project store", () => {
  it("creates, reads back and lists projects newest first", async () => {
    const a = await createProject({ kind: "app", brief: "A support desk my team can triage" });
    await new Promise((r) => setTimeout(r, 5));
    const b = await createProject({ kind: "mcp", brief: "Search my docs", name: "Docs tools" });

    expect(await getProject(a.id)).toEqual(a);
    expect(a.name).toBe("A support desk my team");
    expect(b.name).toBe("Docs tools");
    expect((await listProjects()).map((p) => p.id)).toEqual([b.id, a.id]);
  });

  it("rejects invalid input", async () => {
    await expect(createProject({ kind: "game" as "app", brief: "x".repeat(10) })).rejects.toThrow();
    await expect(createProject({ kind: "app", brief: "  " })).rejects.toThrow();
    await expect(createProject({ kind: "app", brief: "x".repeat(4001) })).rejects.toThrow();
  });

  it("never touches the filesystem for ids that are not ours", async () => {
    await fs.writeFile(path.join(dir, "secret.json"), "{}");
    for (const id of ["../secret", "..\\secret", "not-a-uuid", "", "00000000-0000-0000-0000-000000000000/../../x"]) {
      expect(await getProject(id)).toBeNull();
    }
  });

  it("returns null for unknown projects and an empty list before any exist", async () => {
    expect(await getProject("3f2b8c1e-1d2a-4b3c-9d4e-5f6a7b8c9d0e")).toBeNull();
    expect(await listProjects()).toEqual([]);
  });

  it("skips unreadable project files when listing", async () => {
    const ok = await createProject({ kind: "agent", brief: "Summarize tickets daily" });
    await fs.writeFile(path.join(dir, "projects", "3f2b8c1e-1d2a-4b3c-9d4e-5f6a7b8c9d0e.json"), "{broken");
    expect((await listProjects()).map((p) => p.id)).toEqual([ok.id]);
  });
});

describe("nameFromBrief", () => {
  it("keeps the first five words, capitalized, without punctuation", () => {
    expect(nameFromBrief("a support desk, my team can triage!")).toBe("A support desk my team");
    expect(nameFromBrief("!!!")).toBe("Untitled project");
  });
});
