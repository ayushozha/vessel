import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { zipSync, type Zippable } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createProject } from "./projects";
import { listEntries, readFile, workspaceDir, writeFile } from "./workspace";
import { importZip, previewZip } from "./zip-import";

let dir: string;
let id: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "vessel-zip-"));
  process.env.VESSEL_HOME = dir;
  id = (await createProject({ kind: "app", brief: "test" })).id;
});
afterEach(async () => {
  delete process.env.VESSEL_HOME;
  await fs.rm(dir, { recursive: true, force: true });
});

const text = (s: string) => new TextEncoder().encode(s);
const zip = (files: Zippable) => Buffer.from(zipSync(files));

/** Rewrites the first central-directory entry's uncompressed size, the way a lying archive would. */
function lieAboutSize(buf: Buffer, size: number): Buffer {
  const cd = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  buf.writeUInt32LE(size, cd + 24);
  return buf;
}

describe("zip import", () => {
  it("previews without writing, then imports and unwraps a single top-level folder", async () => {
    const buf = zip({ "my-app/": {}, "my-app/server.js": text("console.log(1);\n"), "my-app/public/index.html": text("<h1>hi</h1>"), "my-app/assets/": {} });
    const plan = await previewZip(id, buf);
    expect(plan.files.map((f) => f.path).sort()).toEqual(["public/index.html", "server.js"]);
    expect(plan).toMatchObject({ folders: ["assets"], conflicts: [], skipped: [], totalBytes: 27 });
    expect(await listEntries(id)).toEqual([]);

    const { changed } = await importZip(id, buf);
    expect(changed).toEqual(expect.arrayContaining(["server.js", "public/index.html", "assets"]));
    expect(await readFile(id, "server.js")).toBe("console.log(1);\n");
    expect((await listEntries(id)).find((e) => e.path === "assets")).toMatchObject({ type: "dir" });
  });

  it("keeps the folder when the zip has more than one top level", async () => {
    const plan = await previewZip(id, zip({ "a/x.js": text("1"), "b.js": text("2") }));
    expect(plan.files.map((f) => f.path).sort()).toEqual(["a/x.js", "b.js"]);
  });

  it("blocks zip-slip paths and skips junk, secrets and symlinks", async () => {
    const buf = zip({
      "../evil.js": text("x"),
      "a/../../evil2.js": text("x"),
      "/abs.js": text("x"),
      "__MACOSX/._server.js": text("x"),
      ".DS_Store": text("x"),
      "node_modules/x/index.js": text("x"),
      ".git/config": text("x"),
      ".env": text("SECRET=1"),
      "link.js": [text("/etc/passwd"), { os: 3, attrs: 0o120777 << 16 }],
      "ok.js": text("fine"),
    });
    const plan = await previewZip(id, buf);
    expect(plan.files.map((f) => f.path)).toEqual(["ok.js"]);
    const reasons = Object.fromEntries(plan.skipped.map((s) => [s.path, s.reason]));
    expect(reasons).toMatchObject({
      "../evil.js": "path escapes the workspace",
      "a/../../evil2.js": "path escapes the workspace",
      "/abs.js": "absolute path",
      "__MACOSX/._server.js": "ignored",
      ".DS_Store": "ignored",
      "node_modules/x/index.js": "ignored",
      ".git/config": "ignored",
      "link.js": "symbolic link",
    });
    expect(reasons[".env"]).toBeDefined();
    await importZip(id, buf);
    expect((await listEntries(id)).map((e) => e.path)).toEqual(["ok.js"]);
    await expect(fs.access(path.join(workspaceDir(id), "..", "evil.js"))).rejects.toThrow();
  });

  it("refuses highly compressed entries as zip bombs before inflating", async () => {
    await expect(previewZip(id, zip({ "bomb.txt": new Uint8Array(400 * 1024) }))).rejects.toThrow(/zip bomb/);
  });

  it("stops inflating at the declared size when the header lies", async () => {
    const buf = lieAboutSize(zip({ "a.txt": text("x".repeat(5000)) }), 10);
    await expect(importZip(id, buf)).rejects.toThrow(/declared size/);
    expect(await listEntries(id)).toEqual([]);
  });

  it("enforces entry, per-file and total size caps", async () => {
    const many = Object.fromEntries(Array.from({ length: 301 }, (_, i) => [`f${i}.txt`, text(String(i))]));
    await expect(previewZip(id, zip(many))).rejects.toThrow(/more than 300 files/);

    const big = await previewZip(id, zip({ "big.bin": randomBytes(513 * 1024), "small.txt": text("s") }));
    expect(big.skipped).toEqual([{ path: "big.bin", reason: "larger than 512 KB" }]);

    const huge = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`r${i}.bin`, randomBytes(500 * 1024)]));
    await expect(previewZip(id, zip(huge))).rejects.toThrow(/more than 10 MB/);
  });

  it("asks before overwriting and rejects archives that are not zips", async () => {
    await writeFile(id, "server.js", "old");
    const buf = zip({ "server.js": text("new") });
    expect((await previewZip(id, buf)).conflicts).toEqual(["server.js"]);
    await expect(importZip(id, buf)).rejects.toThrow(/already exist/);
    expect(await readFile(id, "server.js")).toBe("old");
    await importZip(id, buf, { overwrite: true });
    expect(await readFile(id, "server.js")).toBe("new");
    await expect(previewZip(id, Buffer.from("not a zip at all, just some text"))).rejects.toThrow(/not a zip/);
  });

  it("round-trips binary entries byte for byte", async () => {
    const png = randomBytes(2048);
    await importZip(id, zip({ "img/logo.png": png, "README.md": text("x") }));
    expect(await fs.readFile(path.join(workspaceDir(id), "img", "logo.png"))).toEqual(png);
  });
});
