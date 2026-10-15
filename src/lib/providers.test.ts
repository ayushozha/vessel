import { describe, expect, it, vi } from "vitest";

import { listModels, maskSecret, parseModels } from "./providers";

const respond = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

describe("listModels", () => {
  it("lists OpenAI models with a bearer key", async () => {
    const fetchImpl = respond(200, { data: [{ id: "model-b" }, { id: "model-a" }] });
    const result = await listModels("openai", "sk-test-123456", { fetchImpl });
    expect(result).toEqual({ ok: true, verified: true, models: [{ id: "model-a", label: "model-a" }, { id: "model-b", label: "model-b" }] });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/models");
    expect(init.headers).toEqual({ Authorization: "Bearer sk-test-123456" });
  });

  it("sends Anthropic's key header and version, and uses display names", async () => {
    const fetchImpl = respond(200, { data: [{ id: "model-x", display_name: "Model X" }] });
    const result = await listModels("anthropic", "sk-ant-123456", { fetchImpl });
    expect(result).toMatchObject({ ok: true, models: [{ id: "model-x", label: "Model X" }] });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toEqual({ "x-api-key": "sk-ant-123456", "anthropic-version": "2023-06-01" });
  });

  it("uses the chosen GLM region endpoint", async () => {
    const fetchImpl = respond(200, { data: [{ id: "glm-x" }] });
    await listModels("glm", "glm-key-123456", { region: "china", fetchImpl });
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe("https://open.bigmodel.cn/api/paas/v4/models");
  });

  it("treats a GLM 404 as unverified rather than invalid", async () => {
    const result = await listModels("glm", "glm-key-123456", { fetchImpl: respond(404, {}) });
    expect(result).toEqual({ ok: true, models: [], verified: false });
  });

  it("reports rejected keys as invalid", async () => {
    for (const status of [401, 403]) {
      const result = await listModels("openai", "sk-bad-123456", { fetchImpl: respond(status, { error: "nope" }) });
      expect(result).toMatchObject({ ok: false, error: "invalid_key" });
    }
  });

  it("reports other failures and network errors without throwing", async () => {
    expect(await listModels("anthropic", "k-12345678", { fetchImpl: respond(500, {}) })).toMatchObject({ ok: false, error: "provider_error", status: 500 });
    const offline = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await listModels("openai", "k-12345678", { fetchImpl: offline })).toMatchObject({ ok: false, error: "network_error" });
  });
});

describe("parseModels", () => {
  it("reads ChatGPT plan models by slug and hides unlisted ones", () => {
    const models = parseModels({
      models: [
        { slug: "plan-b", display_name: "Plan B", visibility: "list" },
        { slug: "hidden", display_name: "Hidden", visibility: "hide" },
        { slug: "plan-a", display_name: "Plan A", visibility: "list" },
      ],
    });
    expect(models).toEqual([{ id: "plan-a", label: "Plan A" }, { id: "plan-b", label: "Plan B" }]);
  });

  it("ignores malformed entries and bodies", () => {
    expect(parseModels(null)).toEqual([]);
    expect(parseModels({ data: [{ id: 3 }, {}, { id: "ok" }] })).toEqual([{ id: "ok", label: "ok" }]);
  });
});

it("masks secrets to the last four characters", () => {
  expect(maskSecret("sk-abcdefgh1234")).toBe("…1234");
});
