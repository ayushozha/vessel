import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { updateStore } from "@/lib/credentials";

import { GET as getOne, PATCH } from "./[id]/route";
import { GET as list, POST } from "./route";

const ORIGIN = "http://127.0.0.1:3000";
const post = (body: unknown, origin = ORIGIN) =>
  new Request(`${ORIGIN}/api/projects`, { method: "POST", headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const patch = (id: string, body: unknown, origin = ORIGIN) =>
  PATCH(new Request(`${ORIGIN}/api/projects/${id}`, { method: "PATCH", headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify(body) }), {
    params: Promise.resolve({ id }),
  });
const one = (id: string) => getOne(new Request(`${ORIGIN}/api/projects/${id}`), { params: Promise.resolve({ id }) });

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "vessel-proj-route-"));
  process.env.VESSEL_HOME = dir;
  process.env.VESSEL_CREDENTIALS_PATH = path.join(dir, "credentials.json");
});
afterEach(async () => {
  delete process.env.VESSEL_HOME;
  delete process.env.VESSEL_CREDENTIALS_PATH;
  await fs.rm(dir, { recursive: true, force: true });
});

const connectModel = () =>
  updateStore((s) => {
    s.keys.openai = { apiKey: "sk-test-12345678", model: "m-1", verified: true, savedAt: "now" };
    s.active = "openai";
  });

describe("/api/projects", () => {
  it("requires a connected model before creating a project", async () => {
    const res = await POST(post({ kind: "app", brief: "A support desk" }));
    expect(res.status).toBe(409);
    await updateStore((s) => {
      s.keys.openai = { apiKey: "sk-test-12345678", verified: true, savedAt: "now" }; // key but no model
      s.active = "openai";
    });
    expect((await POST(post({ kind: "app", brief: "A support desk" }))).status).toBe(409);
  });

  it("creates a project, then lists and fetches it", async () => {
    await connectModel();
    const res = await POST(post({ kind: "agent", brief: "Summarize new tickets every morning" }));
    expect(res.status).toBe(201);
    const project = await res.json();
    expect(project).toMatchObject({ kind: "agent", name: "Summarize new tickets every morning" });

    expect((await (await list(new Request(`${ORIGIN}/api/projects`))).json()).projects).toHaveLength(1);
    expect(await (await one(project.id)).json()).toEqual(project);
  });

  it("validates input and unknown ids", async () => {
    await connectModel();
    expect((await POST(post({ kind: "game", brief: "something big" }))).status).toBe(400);
    expect((await POST(post({ kind: "app", brief: "" }))).status).toBe(400);
    expect((await one("../credentials")).status).toBe(404);
    expect((await one("3f2b8c1e-1d2a-4b3c-9d4e-5f6a7b8c9d0e")).status).toBe(404);
  });

  it("blocks cross-origin creation", async () => {
    await connectModel();
    expect((await POST(post({ kind: "app", brief: "A support desk" }, "https://evil.example"))).status).toBe(403);
    expect((await (await list(new Request(`${ORIGIN}/api/projects`))).json()).projects).toHaveLength(0);
  });

  it("lists each project with its file count and runtime state for the projects home", async () => {
    await connectModel();
    await POST(post({ kind: "app", brief: "A support desk" }));
    const [p] = (await (await list(new Request(`${ORIGIN}/api/projects`))).json()).projects;
    expect(p).toMatchObject({ kind: "app", files: 0, runtime: { state: "idle", appUrl: null } });
  });

  it("renames a project, trimming and validating the name", async () => {
    await connectModel();
    const project = await (await POST(post({ kind: "app", brief: "A support desk" }))).json();
    const res = await patch(project.id, { name: "  Helpdesk v2  " });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: project.id, name: "Helpdesk v2", brief: "A support desk" });
    expect((await (await one(project.id)).json()).name).toBe("Helpdesk v2");

    expect((await patch(project.id, { name: "   " })).status).toBe(400);
    expect((await patch(project.id, { name: "x".repeat(81) })).status).toBe(400);
    expect((await patch("3f2b8c1e-1d2a-4b3c-9d4e-5f6a7b8c9d0e", { name: "Nope" })).status).toBe(404);
    expect((await patch(project.id, { name: "Hijack" }, "https://evil.example")).status).toBe(403);
    expect((await (await one(project.id)).json()).name).toBe("Helpdesk v2");
  });
});
