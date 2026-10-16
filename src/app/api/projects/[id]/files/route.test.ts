import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProject } from "@/lib/projects";
import { readBytes, readFile, writeFile } from "@/lib/workspace";
import { onWorkspaceChanged, type WorkspaceChange } from "@/lib/workspace-events";

import { POST as importZip } from "./import-zip/route";
import { DELETE, GET, PATCH, POST, PUT } from "./route";

const ORIGIN = "http://127.0.0.1:3000";
let dir: string;
let id: string;
let changes: ReturnType<typeof vi.fn<(c: WorkspaceChange) => void>>;
let unsubscribe: () => void;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "vessel-files-route-"));
  process.env.VESSEL_HOME = dir;
  id = (await createProject({ kind: "app", brief: "test" })).id;
  changes = vi.fn();
  unsubscribe = onWorkspaceChanged(changes);
});
afterEach(async () => {
  unsubscribe();
  delete process.env.VESSEL_HOME;
  await fs.rm(dir, { recursive: true, force: true });
});

const ctx = () => ({ params: Promise.resolve({ id }) });
const url = (query = "", sub = "") => `${ORIGIN}/api/projects/${id}/files${sub}${query}`;
const req = (method: string, body?: BodyInit, query = "", headers: Record<string, string> = {}) =>
  new Request(url(query), { method, headers: { origin: ORIGIN, ...headers }, body });
const json = (method: string, body: unknown) => req(method, JSON.stringify(body), "", { "Content-Type": "application/json" });
const lastChange = () => changes.mock.calls.at(-1)?.[0];

describe("/api/projects/[id]/files", () => {
  it("refuses cross-origin writes and non-local hosts", async () => {
    const cross = new Request(url(), { method: "PUT", headers: { origin: "https://evil.example" }, body: JSON.stringify({ path: "a.js", content: "x" }) });
    expect((await PUT(cross, ctx())).status).toBe(403);
    const remote = new Request(url().replace("127.0.0.1", "vessel.example.com"), { method: "DELETE", headers: { origin: "http://vessel.example.com" } });
    expect((await DELETE(remote, ctx())).status).toBe(403);
    expect((await importZip(new Request(url("?dryRun=1", "/import-zip"), { method: "POST", body: "x" }), ctx())).status).toBe(403);
    expect(changes).not.toHaveBeenCalled();
  });

  it("uploads files and folders into a target folder, asking before overwrite", async () => {
    const form = new FormData();
    form.append("folder", "src");
    form.append("path", "app.js");
    form.append("file", new File(["console.log(1)"], "app.js"));
    form.append("path", "img/logo.png");
    form.append("file", new File([new Uint8Array([0x89, 0, 1, 2])], "logo.png"));
    form.append("dir", "empty");
    const res = await POST(req("POST", form), ctx());
    expect(res.status).toBe(200);
    expect(lastChange()).toEqual({ projectId: id, source: "upload", paths: ["src/app.js", "src/img/logo.png", "src/empty"] });
    expect(new Uint8Array((await readBytes(id, "src/img/logo.png"))!)).toEqual(new Uint8Array([0x89, 0, 1, 2]));

    const again = new FormData();
    again.append("folder", "src");
    again.append("path", "app.js");
    again.append("file", new File(["v2"], "app.js"));
    const conflict = await POST(req("POST", again), ctx());
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).conflicts).toEqual(["src/app.js"]);
    again.append("overwrite", "1");
    expect((await POST(req("POST", again), ctx())).status).toBe(200);
    expect(await readFile(id, "src/app.js")).toBe("v2");
  });

  it("lists folders, saves text and binary, renames and deletes, emitting each change", async () => {
    expect((await POST(json("POST", { path: "lib", type: "dir" }), ctx())).status).toBe(200);
    expect(lastChange()).toMatchObject({ source: "edit", paths: ["lib"] });
    expect((await POST(json("POST", { path: "lib/a.js", type: "file" }), ctx())).status).toBe(200);
    expect((await POST(json("POST", { path: "lib/a.js", type: "file" }), ctx())).status).toBe(409);

    expect((await PUT(json("PUT", { path: "lib/a.js", content: "let a;\n" }), ctx())).status).toBe(200);
    expect(lastChange()).toMatchObject({ source: "edit", paths: ["lib/a.js"] });
    expect((await PUT(json("PUT", { path: "lib/b.png", base64: Buffer.from([1, 0, 2]).toString("base64") }), ctx())).status).toBe(200);

    const list = await (await GET(new Request(url()), ctx())).json();
    expect(list.files).toContainEqual({ path: "lib", bytes: 0, type: "dir" });
    expect(await (await GET(new Request(url("?path=lib/a.js")), ctx())).json()).toEqual({ path: "lib/a.js", content: "let a;\n", bytes: 7 });
    expect(await (await GET(new Request(url("?path=lib/b.png")), ctx())).json()).toEqual({ path: "lib/b.png", binary: true, bytes: 3 });
    const raw = await GET(new Request(url("?path=lib/b.png&raw=1")), ctx());
    expect(raw.headers.get("content-type")).toBe("image/png");
    expect(raw.headers.get("content-security-policy")).toContain("sandbox");
    expect((await GET(new Request(url("?path=lib/a.js&raw=1")), ctx())).status).toBe(415);

    expect((await PATCH(json("PATCH", { from: "lib", to: "src/lib" }), ctx())).status).toBe(200);
    expect(lastChange()).toMatchObject({ source: "rename", paths: ["lib", "lib/a.js", "lib/b.png", "src/lib", "src/lib/a.js", "src/lib/b.png"] });
    expect((await PATCH(json("PATCH", { from: "src/lib/a.js", to: "../x.js" }), ctx())).status).toBe(400);

    expect((await DELETE(req("DELETE", undefined, "?path=src"), ctx())).status).toBe(200);
    expect(lastChange()).toMatchObject({ source: "delete", paths: ["src", "src/lib", "src/lib/a.js", "src/lib/b.png"] });
    expect((await DELETE(req("DELETE", undefined, "?path=src"), ctx())).status).toBe(404);
  });

  it("previews a zip on dry run and imports it for real, emitting source zip", async () => {
    await writeFile(id, "server.js", "old");
    const zip = zipSync({ "app/server.js": new TextEncoder().encode("new"), "app/public/index.html": new TextEncoder().encode("<h1>"), "app/.DS_Store": new Uint8Array(1) });
    const post = (query: string) => importZip(new Request(url(query, "/import-zip"), { method: "POST", headers: { origin: ORIGIN }, body: zip }), ctx());

    const dry = await (await post("?dryRun=1")).json();
    expect(dry).toMatchObject({ conflicts: ["server.js"], totalBytes: 7, skipped: [{ path: "app/.DS_Store", reason: "ignored" }] });
    expect(changes).not.toHaveBeenCalled();
    expect((await post("")).status).toBe(409);
    expect(await readFile(id, "server.js")).toBe("old");

    expect((await post("?overwrite=1")).status).toBe(200);
    expect(await readFile(id, "server.js")).toBe("new");
    expect(lastChange()).toEqual({ projectId: id, source: "zip", paths: expect.arrayContaining(["server.js", "public/index.html"]) });
  });
});
