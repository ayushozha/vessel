import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createProject } from "./projects";
import { createFolder, deleteEntry, deleteFile, findConflicts, isBinary, LIMITS, listEntries, listFiles, readBytes, readFile, renameEntry, snapshot, validatePath, workspaceDir, writeFile, writeFiles } from "./workspace";

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

  it("enforces the total workspace size limit", async () => {
    const saved = LIMITS.totalBytes;
    LIMITS.totalBytes = 10;
    try {
      await writeFile(id, "a.txt", "12345");
      await expect(writeFile(id, "b.txt", "123456")).rejects.toThrow(/limited to/);
      await writeFile(id, "a.txt", "1234567890"); // replacing counts the new size, not both
    } finally {
      LIMITS.totalBytes = saved;
    }
  });

  it("round-trips binary content and detects it", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
    await writeFile(id, "img/logo.png", bytes);
    expect(new Uint8Array((await readBytes(id, "img/logo.png"))!)).toEqual(bytes);
    expect(isBinary("img/logo.png")).toBe(true);
    expect(isBinary("data.bin", bytes)).toBe(true);
    expect(isBinary("notes.txt", new TextEncoder().encode("héllo"))).toBe(false);
    await writeFile(id, "a.js", "x");
    expect(await snapshot(id)).toContain('<file path="img/logo.png" omitted="8 bytes" />');
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

describe("folders, rename and delete", () => {
  it("creates empty folders that show up in the listing", async () => {
    expect(await createFolder(id, "src/components")).toEqual(["src", "src/components"]);
    expect(await listEntries(id)).toEqual([
      { path: "src", bytes: 0, type: "dir" },
      { path: "src/components", bytes: 0, type: "dir" },
    ]);
    expect(await listFiles(id)).toEqual([]);
    await expect(createFolder(id, "src")).rejects.toThrow(/already exists/);
    await writeFile(id, "file.txt", "x");
    await expect(createFolder(id, "file.txt/sub")).rejects.toThrow(/is a file/);
    await expect(createFolder(id, "../out")).rejects.toThrow();
  });

  it("renames files and moves folders without overwriting unless asked", async () => {
    await writeFile(id, "src/a.js", "a");
    await writeFile(id, "src/lib/b.js", "b");
    await writeFile(id, "c.js", "c");
    expect(await renameEntry(id, "src", "app")).toEqual(["src", "src/a.js", "src/lib", "src/lib/b.js", "app", "app/a.js", "app/lib", "app/lib/b.js"]);
    expect(await readFile(id, "app/lib/b.js")).toBe("b");
    await expect(renameEntry(id, "c.js", "app/a.js")).rejects.toThrow(/already exists/);
    await renameEntry(id, "c.js", "app/a.js", { overwrite: true });
    expect(await readFile(id, "app/a.js")).toBe("c");
    await expect(renameEntry(id, "app", "app/lib/inner")).rejects.toThrow(/into itself/);
    await expect(renameEntry(id, "missing.js", "x.js")).rejects.toThrow(/does not exist/);
    await writeFile(id, "d.js", "d");
    await expect(renameEntry(id, "d.js", "app", { overwrite: true })).rejects.toThrow(/only a file can replace/);
    await renameEntry(id, "d.js", "D.js"); // case-only rename is not a conflict with itself
    expect((await listFiles(id)).map((f) => f.path)).toContain("D.js");
  });

  it("deletes folders recursively and reports what was removed", async () => {
    await writeFile(id, "src/a.js", "a");
    await writeFile(id, "src/lib/b.js", "b");
    expect(await deleteEntry(id, "src")).toEqual(["src", "src/a.js", "src/lib", "src/lib/b.js"]);
    expect(await listEntries(id)).toEqual([]);
    await expect(deleteEntry(id, "src")).rejects.toThrow(/does not exist/);
  });

  it("checks a whole batch before writing any of it", async () => {
    await writeFile(id, "keep.js", "k");
    expect(await findConflicts(id, ["keep.js", "new.js", "KEEP.JS"])).toEqual(["keep.js", "KEEP.JS"]);
    await expect(writeFiles(id, [{ path: "ok.js", data: "1" }, { path: "../bad.js", data: "2" }])).rejects.toThrow();
    await expect(writeFiles(id, [{ path: "new.js", data: "1" }, { path: "keep.js", data: "2" }], { overwrite: false })).rejects.toThrow(/already exists/);
    await expect(writeFiles(id, [{ path: "x", data: "1" }, { path: "x/y.js", data: "2" }])).rejects.toThrow(/is a file/);
    expect((await listFiles(id)).map((f) => f.path)).toEqual(["keep.js"]);
  });
});
