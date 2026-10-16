import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createProject } from "./projects";
import { deleteFile, LIMITS, listFiles, readFile, snapshot, validatePath, workspaceDir, writeFile } from "./workspace";

let dir: string;
let id: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "vessel-ws-"));
  process.env.VESSEL_HOME = dir;
  id = (await createProject({ kind: "app", brief: "test" })).id;
});
afterEach(async () => {
  delete process.env.VESSEL_HOME;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("validatePath", () => {
  it.each([
    ["src/server.js", "src/server.js"],
    ["./public/index.html", "public/index.html"],
    ["src\\win\\path.ts", "src/win/path.ts"],
    [".gitignore", ".gitignore"],
    [".env.example", ".env.example"],
  ])("accepts %s", (input, expected) => expect(validatePath(input)).toEqual({ ok: true, path: expected }));

  it.each(["", "/etc/passwd", "C:/Windows/x", "../x", "a/../../x", "node_modules/x.js", ".git/config", ".env", ".env.local", "a/.hidden", "a/b*c", "x".repeat(201)])(
    "rejects %j",
    (input) => expect(validatePath(input).ok).toBe(false),
  );
});

describe("workspace files", () => {
  it("writes, lists, reads and deletes inside the project's workspace only", async () => {
    await writeFile(id, "server.js", "a\n");
    await writeFile(id, "public/app.js", "b\n");
    expect(await listFiles(id)).toEqual([
      { path: "public/app.js", bytes: 2 },
      { path: "server.js", bytes: 2 },
    ]);
    expect(await readFile(id, "server.js")).toBe("a\n");
    expect(await readFile(id, "../project.json")).toBeNull();
    await expect(writeFile(id, "../escape.js", "x")).rejects.toThrow();
    expect(await deleteFile(id, "server.js")).toBe(true);
    expect(await deleteFile(id, "server.js")).toBe(false);
    await expect(fs.access(path.join(dir, "projects", "escape.js"))).rejects.toThrow();
  });

  it("enforces the per-file size limit", async () => {
    await expect(writeFile(id, "big.txt", "x".repeat(LIMITS.fileBytes + 1))).rejects.toThrow(/larger than/);
  });

  it("refuses invalid project ids", () => {
    expect(() => workspaceDir("../../x")).toThrow();
  });

  it("builds a bounded snapshot for model context", async () => {
    await writeFile(id, "a.js", "const a = 1;\n");
    await writeFile(id, "big.js", "y".repeat(70 * 1024));
    const snap = await snapshot(id);
    expect(snap).toContain('<file path="a.js">\nconst a = 1;\n');
    expect(snap).toContain('<file path="big.js" omitted="71680 bytes" />');
    expect(await snapshot(id, 5)).toContain('<file path="a.js" omitted=');
  });
});
