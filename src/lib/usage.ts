// Token usage and cost per run. Prices come from pydantic's genai-prices dataset (bundled with the package, so it
// works offline); Vessel keeps no price table of its own. A model the dataset does not know gets tokens but no cost,
// and ChatGPT plan runs are billed to the plan, not per token, so they never show a price.
import { calcPrice } from "@pydantic/genai-prices";
import type { LanguageModelUsage } from "ai";

import type { ProviderId } from "./providers";

export type TokenUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number };
export type Pricing = "api" | "plan" | "unknown";

export const emptyUsage = (): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });

export function addUsage(total: TokenUsage, u: LanguageModelUsage): void {
  total.input += u.inputTokens ?? 0;
  total.output += u.outputTokens ?? 0;
  total.cacheRead += u.inputTokenDetails?.cacheReadTokens ?? 0;
  total.cacheWrite += u.inputTokenDetails?.cacheWriteTokens ?? 0;
  total.reasoning += u.outputTokenDetails?.reasoningTokens ?? 0;
}

// genai-prices provider ids. GLM keys work on either Z.ai (global) or BigModel (China); both price the same models.
const PRICE_PROVIDERS: Record<Exclude<ProviderId, "chatgpt">, string[]> = {
  openai: ["openai"],
  anthropic: ["anthropic"],
  glm: ["zai", "zhipuai"],
};

/** The run's cost in USD, or why there is none. */
export function priceUsage(provider: ProviderId, modelId: string, usage: TokenUsage): { pricing: Pricing; costUsd: number | null } {
  if (provider === "chatgpt") return { pricing: "plan", costUsd: null };
  // genai-prices counts input_tokens including cache reads, like the AI SDK's inputTokens.
  const tokens = { input_tokens: usage.input, output_tokens: usage.output, cache_read_tokens: usage.cacheRead, cache_write_tokens: usage.cacheWrite };
  for (const providerId of PRICE_PROVIDERS[provider]) {
    try {
      const price = calcPrice(tokens, modelId, { providerId });
      if (price) return { pricing: "api", costUsd: price.total_price };
    } catch {
      // An unknown provider id or malformed price entry: try the next source, then report it as unpriced.
    }
  }
  return { pricing: "unknown", costUsd: null };
}
