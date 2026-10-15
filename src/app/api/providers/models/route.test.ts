import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getChatgptAccessToken } from "@/lib/chatgpt";
import { updateStore } from "@/lib/credentials";

import { GET } from "./route";

vi.mock("@/lib/chatgpt", async (original) => ({
  ...(await original<typeof import("@/lib/chatgpt")>()),
  getChatgptAccessToken: vi.fn(),
}));

const get = (provider: string) => new Request(`http://127.0.0.1:3000/api/providers/models?provider=${provider}`);
const stubFetch = (status: number, body: unknown) => {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fn);
  return fn;
};

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "vessel-models-"));
  process.env.VESSEL_CREDENTIALS_PATH = path.join(dir, "credentials.json");
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  delete process.env.VESSEL_CREDENTIALS_PATH;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("/api/providers/models", () => {
  it("rejects unknown providers and unconnected ones", async () => {
    expect((await GET(get("other"))).status).toBe(400);
    expect((await GET(get("anthropic"))).status).toBe(404);
  });

  it("lists models with the stored key and region", async () => {
    await updateStore((s) => {
      s.keys.glm = { apiKey: "glm-key-123456", region: "china", verified: true, savedAt: "now" };
    });
    const fetchFn = stubFetch(200, { data: [{ id: "m-1" }] });
    const res = await GET(get("glm"));
    expect(await res.json()).toEqual({ models: [{ id: "m-1", label: "m-1" }], verified: true });
    expect((fetchFn.mock.calls[0] as unknown as [string])[0]).toBe("https://open.bigmodel.cn/api/paas/v4/models");
  });

  it("uses a fresh ChatGPT access token for plan models", async () => {
    vi.mocked(getChatgptAccessToken).mockResolvedValue("access-1");
    const fetchFn = stubFetch(200, { models: [{ slug: "plan-1", display_name: "Plan 1", visibility: "list" }] });
    expect(await (await GET(get("chatgpt"))).json()).toEqual({ models: [{ id: "plan-1", label: "Plan 1" }], verified: true });
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toEqual({ Authorization: "Bearer access-1" });
  });

  it("asks the user to reconnect when the ChatGPT refresh fails", async () => {
    vi.mocked(getChatgptAccessToken).mockRejectedValue(new Error("invalid_grant"));
    const res = await GET(get("chatgpt"));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/Connect again/);
  });

  it("reports a key that stopped working", async () => {
    await updateStore((s) => {
      s.keys.openai = { apiKey: "sk-revoked-12345", verified: true, savedAt: "now" };
    });
    stubFetch(401, {});
    expect((await GET(get("openai"))).status).toBe(401);
  });
});
