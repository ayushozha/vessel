import { findProvider } from "@pydantic/genai-prices";
import { describe, expect, it } from "vitest";

import { totalSpend } from "@/app/build/[id]/spend";

import { formatUsd } from "./format-usd";
import type { ChatMessage } from "./generator/history";
import { addUsage, emptyUsage, priceUsage } from "./usage";

// A priced model straight from the genai-prices dataset, so the test names no model itself.
const pricedModel = (providerId: string) => findProvider({ providerId })!.models.find((m) => typeof m.prices === "object" && m.prices && "input_mtok" in m.prices && "cache_read_mtok" in m.prices)!.id;
const usage = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0, reasoning: 0 };

describe("priceUsage", () => {
  it("prices API-key runs from genai-prices, cache reads included", () => {
    const full = priceUsage("openai", pricedModel("openai"), usage);
    expect(full.pricing).toBe("api");
    expect(full.costUsd).toBeGreaterThan(0);
    const cached = priceUsage("openai", pricedModel("openai"), { ...usage, cacheRead: 500_000 });
    expect(cached.costUsd!).toBeLessThan(full.costUsd!);
    expect(priceUsage("anthropic", pricedModel("anthropic"), usage)).toMatchObject({ pricing: "api", costUsd: expect.any(Number) });
  });

  it("never invents a price: ChatGPT plan runs are plan usage, unknown models are unpriced", () => {
    expect(priceUsage("chatgpt", "any-plan-model", usage)).toEqual({ pricing: "plan", costUsd: null });
    expect(priceUsage("openai", "not-a-real-model-xyz", usage)).toEqual({ pricing: "unknown", costUsd: null });
    expect(priceUsage("glm", "not-a-real-model-xyz", usage)).toEqual({ pricing: "unknown", costUsd: null });
  });
});

it("adds AI SDK usage across calls", () => {
  const total = emptyUsage();
  const part = {
    inputTokens: 100,
    inputTokenDetails: { noCacheTokens: 60, cacheReadTokens: 40, cacheWriteTokens: undefined },
    outputTokens: 50,
    outputTokenDetails: { textTokens: 45, reasoningTokens: 5 },
    totalTokens: 150,
  };
  addUsage(total, part);
  addUsage(total, { ...part, outputTokens: undefined });
  expect(total).toEqual({ input: 200, output: 50, cacheRead: 80, cacheWrite: 0, reasoning: 10 });
});

it("totals a project's runs and formats money", () => {
  const at = new Date().toISOString();
  const m = (metrics: Partial<NonNullable<ChatMessage["metrics"]>>): ChatMessage => ({
    role: "assistant",
    text: "",
    at,
    metrics: { durationMs: 1, firstTokenMs: null, outputTokens: 0, model: "m", ...metrics },
  });
  const t = totalSpend([
    { role: "user", text: "hi", at },
    m({ usage: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 0, reasoning: 0 }, costUsd: 0.01, pricing: "api" }),
    m({ usage: { input: 3000, output: 700, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, costUsd: null, pricing: "plan" }),
    m({ outputTokens: 40 }), // recorded before usage tracking existed
  ]);
  expect(t).toMatchObject({ runs: 3, input: 4000, output: 1240, cacheRead: 200, costUsd: 0.01, priced: 1, plan: 1, unpriced: 1 });
  expect(formatUsd(0.0123456)).toBe("$0.0123");
  expect(formatUsd(12.345)).toBe("$12.35");
});
