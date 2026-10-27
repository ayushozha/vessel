// Whether the user has picked a provider and model, which every step after onboarding needs.
import { readStore } from "./credentials";
import type { ProviderId } from "./providers";

/** The linked Wasmer account. Adorable needs one before anything else: Step 1 of onboarding. */
export async function getWasmerAccount(): Promise<{ username: string } | null> {
  const { wasmer } = await readStore();
  return wasmer ? { username: wasmer.username } : null;
}

export type ActiveModel = { provider: ProviderId; model: string };

export async function getActiveModel(): Promise<ActiveModel | null> {
  const store = await readStore();
  const provider = store.active;
  if (!provider) return null;
  const model = provider === "chatgpt" ? store.chatgpt?.model : store.keys[provider]?.model;
  return model ? { provider, model } : null;
}
