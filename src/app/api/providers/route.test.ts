import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readStore } from "@/lib/credentials";

import { DELETE, GET, PATCH, POST } from "./route";

const ORIGIN = "http://127.0.0.1:3000";
const req = (method: string, body?: unknown, { origin = ORIGIN, url = `${ORIGIN}/api/providers` } = {}) =>
  new Request(url, { method, headers: { "Content-Type": "application/json", origin }, body: body ? JSON.stringify(body) : undefined });

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "vessel-route-"));
  process.env.VESSEL_CREDENTIALS_PATH = path.join(dir, "credentials.json");
});
afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.VESSEL_CREDENTIALS_PATH;
  await fs.rm(dir, { recursive: true, force: true });
});

const stubFetch = (status: number, body: unknown) =>
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));

describe("/api/providers", () => {
  it("validates, stores and masks a key, then selects a model", async () => {
    stubFetch(200, { data: [{ id: "m-1" }] });
    const saved = await POST(req("POST", { provider: "openai", apiKey: "sk-live-abcdef1234" }));
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ models: [{ id: "m-1", label: "m-1" }], verified: true });

    const picked = await PATCH(req("PATCH", { provider: "openai", model: "m-1" }));
    expect(picked.status).toBe(200);

    const status = await (await GET(req("GET"))).json();
    expect(JSON.stringify(status)).not.toContain("sk-live-abcdef");
    expect(status.active).toBe("openai");
    expect(status.keys.find((k: { id: string }) => k.id === "openai")).toMatchObject({ keyHint: "…1234", model: "m-1" });
  });

  it("does not store a key the provider rejects", async () => {
    stubFetch(401, { error: "bad" });
    const res = await POST(req("POST", { provider: "anthropic", apiKey: "sk-ant-wrong-key" }));
    expect(res.status).toBe(401);
    expect((await readStore()).keys.anthropic).toBeUndefined();
  });

  it("validates input", async () => {
    expect((await POST(req("POST", { provider: "other", apiKey: "x".repeat(20) }))).status).toBe(400);
    expect((await POST(req("POST", { provider: "openai", apiKey: "has spaces in it" }))).status).toBe(400);
    expect((await PATCH(req("PATCH", { provider: "glm", model: "m" }))).status).toBe(404);
  });

  it("removes a provider and clears it as active", async () => {
    stubFetch(200, { data: [] });
    await POST(req("POST", { provider: "glm", apiKey: "glm-key-123456", region: "china" }));
    await PATCH(req("PATCH", { provider: "glm", model: "custom" }));
    expect((await readStore()).keys.glm?.region).toBe("china");
    const res = await DELETE(req("DELETE", undefined, { url: `${ORIGIN}/api/providers?provider=glm` }));
    expect(res.status).toBe(204);
    const store = await readStore();
    expect(store.keys.glm).toBeUndefined();
    expect(store.active).toBeUndefined();
  });

  it("blocks cross-origin writes and non-local hosts", async () => {
    stubFetch(200, { data: [] });
    expect((await POST(req("POST", { provider: "openai", apiKey: "sk-12345678" }, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await GET(req("GET", undefined, { url: "https://vessel.example.com/api/providers" }))).status).toBe(403);
    expect((await readStore()).keys.openai).toBeUndefined();
  });
});

describe("host detection", () => {
  afterEach(() => {
    delete process.env.CHATGPT_LOCAL_MODE;
  });

  it("trusts the Host header the browser used, since Next dev reports localhost in request.url", async () => {
    process.env.CHATGPT_LOCAL_MODE = "true";
    const viaDevServer = new Request("http://localhost:3000/api/providers", { headers: { host: "127.0.0.1:3000" } });
    expect((await (await GET(viaDevServer)).json()).chatgpt.localMode).toEqual({ enabled: true, reason: null });

    stubFetch(401, {});
    const write = new Request("http://localhost:3000/api/providers", {
      method: "POST",
      headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai", apiKey: "sk-12345678" }),
    });
    expect((await POST(write)).status).toBe(401); // reached the provider, not blocked as cross-origin
  });
});
