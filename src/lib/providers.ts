// Model providers. Adorable is model-agnostic: model lists always come from the provider's own API.

export const KEY_PROVIDERS = {
  openai: { label: "OpenAI" },
  anthropic: { label: "Anthropic" },
  glm: { label: "GLM (Z.ai)" },
} as const;

export type KeyProviderId = keyof typeof KEY_PROVIDERS;
export type ProviderId = KeyProviderId | "chatgpt";
export const KEY_PROVIDER_IDS = Object.keys(KEY_PROVIDERS) as KeyProviderId[];

export const GLM_REGIONS = {
  global: "https://api.z.ai/api/paas/v4",
  china: "https://open.bigmodel.cn/api/paas/v4",
} as const;
export type GlmRegion = keyof typeof GLM_REGIONS;

export type Model = { id: string; label: string };
export type ListModelsResult =
  | { ok: true; models: Model[]; verified: boolean }
  | { ok: false; error: "invalid_key" | "provider_error" | "network_error"; status?: number; message: string };

function modelsRequest(id: ProviderId, secret: string, region: GlmRegion): { url: string; headers: Record<string, string> } {
  switch (id) {
    case "openai":
    case "chatgpt":
      return { url: "https://api.openai.com/v1/models", headers: { Authorization: `Bearer ${secret}` } };
    case "anthropic":
      return {
        url: "https://api.anthropic.com/v1/models?limit=1000",
        headers: { "x-api-key": secret, "anthropic-version": "2023-06-01" },
      };
    case "glm":
      return { url: `${GLM_REGIONS[region]}/models`, headers: { Authorization: `Bearer ${secret}` } };
  }
}

type RawModel = { id?: unknown; slug?: unknown; display_name?: unknown; visibility?: unknown };

/** OpenAI, Anthropic and GLM return `data[]`; ChatGPT plan usage returns `models[]` with slug + visibility. */
export function parseModels(body: unknown): Model[] {
  const b = body as { data?: RawModel[]; models?: RawModel[] } | null;
  const raw = Array.isArray(b?.models)
    ? b.models.filter((m) => m.visibility === undefined || m.visibility === "list").map((m) => ({ ...m, id: m.slug ?? m.id }))
    : Array.isArray(b?.data)
      ? b.data
      : [];
  return raw
    .filter((m): m is RawModel & { id: string } => typeof m.id === "string" && m.id.length > 0)
    .map((m) => ({ id: m.id, label: typeof m.display_name === "string" ? m.display_name : m.id }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export async function listModels(
  id: ProviderId,
  secret: string,
  { region = "global", fetchImpl = fetch }: { region?: GlmRegion; fetchImpl?: typeof fetch } = {},
): Promise<ListModelsResult> {
  const { url, headers } = modelsRequest(id, secret, region);
  let res: Response;
  try {
    res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000), cache: "no-store" });
  } catch {
    return { ok: false, error: "network_error", message: "Could not reach the provider. Check your connection." };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: "invalid_key", status: res.status, message: "The provider rejected this key." };
  }
  // GLM's model-list route is not officially documented; a 404 means we cannot verify, not that the key is bad.
  if (id === "glm" && res.status === 404) return { ok: true, models: [], verified: false };
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 200);
    return { ok: false, error: "provider_error", status: res.status, message: text || `Provider returned ${res.status}.` };
  }
  return { ok: true, models: parseModels(await res.json().catch(() => null)), verified: true };
}

export const maskSecret = (secret: string) => `…${secret.slice(-4)}`;
