import { z } from "zod";

import { localModeError } from "@/lib/chatgpt";
import { publicStatus, readStore, updateStore } from "@/lib/credentials";
import { effectiveUrl, guardLocal } from "@/lib/guard";
import { listModels } from "@/lib/providers";

const KeyProvider = z.enum(["openai", "anthropic", "glm"]);
const AnyProvider = z.enum(["openai", "anthropic", "glm", "chatgpt"]);

const SaveKey = z.object({
  provider: KeyProvider,
  apiKey: z.string().trim().min(8).max(512).regex(/^\S+$/, "API keys cannot contain spaces"),
  region: z.enum(["global", "china"]).optional(),
});

const SelectModel = z.object({
  provider: AnyProvider,
  model: z.string().trim().min(1).max(200),
});

const bad = (message: string, status = 400) => Response.json({ error: message }, { status });

export async function GET(request: Request) {
  const blocked = guardLocal(request);
  if (blocked) return blocked;
  const status = publicStatus(await readStore());
  const reason = localModeError(effectiveUrl(request).href);
  return Response.json({ ...status, chatgpt: { ...status.chatgpt, localMode: { enabled: !reason, reason } } });
}

/** Validate a key against the provider's model list, then store it. */
export async function POST(request: Request) {
  const blocked = guardLocal(request);
  if (blocked) return blocked;
  const parsed = SaveKey.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return bad(parsed.error.issues[0]?.message ?? "Invalid request.");
  const { provider, apiKey } = parsed.data;
  const region = provider === "glm" ? (parsed.data.region ?? "global") : undefined;

  const result = await listModels(provider, apiKey, { region });
  if (!result.ok) return bad(result.message, result.error === "invalid_key" ? 401 : 502);

  await updateStore((s) => {
    s.keys[provider] = { apiKey, region, verified: result.verified, savedAt: new Date().toISOString() };
  });
  return Response.json({ models: result.models, verified: result.verified });
}

/** Choose the model for a connected provider and make that provider active. */
export async function PATCH(request: Request) {
  const blocked = guardLocal(request);
  if (blocked) return blocked;
  const parsed = SelectModel.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return bad(parsed.error.issues[0]?.message ?? "Invalid request.");
  const { provider, model } = parsed.data;

  const ok = await updateStore((s) => {
    const cred = provider === "chatgpt" ? s.chatgpt : s.keys[provider];
    if (!cred) return false;
    cred.model = model;
    s.active = provider;
    return true;
  });
  return ok ? Response.json({ provider, model }) : bad("Connect this provider first.", 404);
}

export async function DELETE(request: Request) {
  const blocked = guardLocal(request);
  if (blocked) return blocked;
  const parsed = AnyProvider.safeParse(new URL(request.url).searchParams.get("provider"));
  if (!parsed.success) return bad("Unknown provider.");
  const provider = parsed.data;
  await updateStore((s) => {
    if (provider === "chatgpt") delete s.chatgpt;
    else delete s.keys[provider];
    if (s.active === provider) delete s.active;
  });
  return new Response(null, { status: 204 });
}
