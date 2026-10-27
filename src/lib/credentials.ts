// Local credential store. Server-only: never import from a client component.
// Secrets live in one owner-only file outside the repo; routes only ever return masked values.
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

import { KEY_PROVIDER_IDS, maskSecret, type ProviderId } from "./providers";

const KeyCredential = z.object({
  apiKey: z.string(),
  region: z.enum(["global", "china"]).optional(),
  model: z.string().optional(),
  verified: z.boolean(),
  savedAt: z.string(),
});

const ChatgptCredential = z.object({
  clientId: z.string(),
  sub: z.string(),
  email: z.string().optional(),
  idToken: z.string(),
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  expiresAt: z.number(),
  scopes: z.array(z.string()),
  model: z.string().optional(),
  savedAt: z.string(),
});

const PendingChatgpt = z.object({
  state: z.string(),
  nonce: z.string(),
  verifier: z.string(),
  redirectUri: z.string(),
  clientId: z.string().optional(), // set on reauthorization
  expiresAt: z.number(),
});

/** The linked wasmer.io account: a personal API token from the `wasmer login` flow (src/lib/wasmer-login.ts). */
const WasmerCredential = z.object({
  token: z.string(),
  username: z.string(),
  email: z.string().optional(),
  registry: z.string(),
  savedAt: z.string(),
});

const Store = z.object({
  version: z.literal(1),
  hostId: z.string(),
  active: z.enum(["openai", "anthropic", "glm", "chatgpt"]).optional(),
  keys: z.object({
    openai: KeyCredential.optional(),
    anthropic: KeyCredential.optional(),
    glm: KeyCredential.optional(),
  }),
  chatgpt: ChatgptCredential.optional(),
  pendingChatgpt: PendingChatgpt.optional(),
  wasmer: WasmerCredential.optional(),
});

export type Store = z.infer<typeof Store>;
export type WasmerCredential = z.infer<typeof WasmerCredential>;
export type KeyCredential = z.infer<typeof KeyCredential>;
export type ChatgptCredential = z.infer<typeof ChatgptCredential>;
export type PendingChatgpt = z.infer<typeof PendingChatgpt>;

export const credentialsPath = () =>
  process.env.VESSEL_CREDENTIALS_PATH || path.join(os.homedir(), ".config", "vessel", "credentials.json");

export async function readStore(): Promise<Store> {
  let text: string;
  try {
    text = await fs.readFile(/*turbopackIgnore: true*/ credentialsPath(), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return { version: 1, hostId: `urn:uuid:${randomUUID()}`, keys: {} };
  }
  // A corrupt file is an error, never silently replaced: it holds the user's credentials.
  return Store.parse(JSON.parse(text));
}

async function writeStore(store: Store) {
  const file = credentialsPath();
  await fs.mkdir(/*turbopackIgnore: true*/ path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(/*turbopackIgnore: true*/ tmp, JSON.stringify(Store.parse(store), null, 2), { mode: 0o600 });
  await fs.rename(/*turbopackIgnore: true*/ tmp, file);
}

// Serialize read-modify-write cycles within this server process.
let queue: Promise<unknown> = Promise.resolve();
export function updateStore<T>(fn: (store: Store) => T | Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const store = await readStore();
    const result = await fn(store);
    await writeStore(store);
    return result;
  });
  queue = run.catch(() => undefined);
  return run;
}

/** Removes and returns the pending ChatGPT transaction, so each one can be used once. */
export const consumePendingChatgpt = () =>
  updateStore((s) => {
    const pending = s.pendingChatgpt;
    delete s.pendingChatgpt;
    return pending;
  });

export type PublicStatus = {
  active?: ProviderId;
  keys: { id: (typeof KEY_PROVIDER_IDS)[number]; connected: boolean; keyHint?: string; region?: string; model?: string; verified?: boolean }[];
  chatgpt: { connected: boolean; email?: string; model?: string; expiresAt?: number };
};

export function publicStatus(store: Store): PublicStatus {
  return {
    active: store.active,
    keys: KEY_PROVIDER_IDS.map((id) => {
      const c = store.keys[id];
      return c
        ? { id, connected: true, keyHint: maskSecret(c.apiKey), region: c.region, model: c.model, verified: c.verified }
        : { id, connected: false };
    }),
    chatgpt: store.chatgpt
      ? { connected: true, email: store.chatgpt.email, model: store.chatgpt.model, expiresAt: store.chatgpt.expiresAt }
      : { connected: false },
  };
}
