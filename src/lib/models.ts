// Turns the user's connected provider into an AI SDK model. Server-only.
// The model id always comes from the user's saved choice; nothing is hardcoded.
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

import { getChatgptAccessToken } from "./chatgpt";
import { readStore } from "./credentials";
import { GLM_REGIONS, type ProviderId } from "./providers";

export type ResolvedModel = {
  provider: ProviderId;
  modelId: string;
  model: LanguageModel;
  providerOptions?: { openai: { store: boolean } };
};

// Parameters the ChatGPT plan route rejects (developers.openai.com/siwc/token-sharing-open-source/preview-limitations).
const CHATGPT_UNSUPPORTED = [
  "background", "conversation", "max_output_tokens", "max_tool_calls", "metadata", "moderation", "multi_agent",
  "prompt", "prompt_cache_retention", "safety_identifier", "temperature", "top_logprobs", "top_p", "truncation",
  "user", "previous_response_id",
];

type ResponsesBody = { input?: unknown; instructions?: string; [key: string]: unknown };
type InputItem = { role?: string; content?: unknown };

/** Make a Responses API body acceptable to ChatGPT plan usage: no unsupported params, no system items, store off, streaming on. */
export function sanitizeChatgptBody(body: ResponsesBody): ResponsesBody {
  const out: ResponsesBody = { ...body, store: false, stream: true };
  for (const key of CHATGPT_UNSUPPORTED) delete out[key];
  if (Array.isArray(out.input)) {
    const system: string[] = [];
    out.input = (out.input as InputItem[]).filter((item) => {
      if (item?.role !== "system") return true;
      if (typeof item.content === "string") system.push(item.content);
      else if (Array.isArray(item.content)) for (const c of item.content) if (typeof c?.text === "string") system.push(c.text);
      return false;
    });
    if (system.length) out.instructions = [out.instructions, ...system].filter(Boolean).join("\n\n");
  }
  return out;
}

const chatgptFetch: typeof fetch = async (input, init) => {
  if (init?.method === "POST" && typeof init.body === "string") {
    try {
      init = { ...init, body: JSON.stringify(sanitizeChatgptBody(JSON.parse(init.body))) };
    } catch {
      // Not JSON: send as is.
    }
  }
  return fetch(input, init);
};

/** The active provider and model, ready for streamText. Null when none is connected or chosen. */
export async function resolveModel(): Promise<ResolvedModel | null> {
  const store = await readStore();
  const provider = store.active;
  if (!provider) return null;

  if (provider === "chatgpt") {
    const modelId = store.chatgpt?.model;
    const token = modelId ? await getChatgptAccessToken() : null;
    if (!modelId || !token) return null;
    const openai = createOpenAI({ apiKey: token, fetch: chatgptFetch });
    return { provider, modelId, model: openai.responses(modelId), providerOptions: { openai: { store: false } } };
  }

  const cred = store.keys[provider];
  if (!cred?.model) return null;
  const modelId = cred.model;
  switch (provider) {
    case "openai":
      return { provider, modelId, model: createOpenAI({ apiKey: cred.apiKey }).responses(modelId) };
    case "anthropic":
      return { provider, modelId, model: createAnthropic({ apiKey: cred.apiKey })(modelId) };
    case "glm":
      return {
        provider,
        modelId,
        model: createOpenAICompatible({ name: "glm", baseURL: GLM_REGIONS[cred.region ?? "global"], apiKey: cred.apiKey }).chatModel(modelId),
      };
  }
}
