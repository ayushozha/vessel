import { z } from "zod";

import { getChatgptAccessToken } from "@/lib/chatgpt";
import { readStore } from "@/lib/credentials";
import { guardLocal } from "@/lib/guard";
import { listModels } from "@/lib/providers";

/** Re-fetch the model list for an already connected provider using the stored credential. */
export async function GET(request: Request) {
  const blocked = guardLocal(request);
  if (blocked) return blocked;
  const parsed = z.enum(["openai", "anthropic", "glm", "chatgpt"]).safeParse(new URL(request.url).searchParams.get("provider"));
  if (!parsed.success) return Response.json({ error: "Unknown provider." }, { status: 400 });
  const provider = parsed.data;

  let secret: string | null;
  let region: "global" | "china" | undefined;
  try {
    if (provider === "chatgpt") {
      secret = await getChatgptAccessToken();
    } else {
      const cred = (await readStore()).keys[provider];
      secret = cred?.apiKey ?? null;
      region = cred?.region;
    }
  } catch {
    return Response.json({ error: "Your ChatGPT session expired. Connect again." }, { status: 401 });
  }
  if (!secret) return Response.json({ error: "Connect this provider first." }, { status: 404 });

  const result = await listModels(provider, secret, { region });
  return result.ok
    ? Response.json({ models: result.models, verified: result.verified })
    : Response.json({ error: result.message }, { status: result.error === "invalid_key" ? 401 : 502 });
}
