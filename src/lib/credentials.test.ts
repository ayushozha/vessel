import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { consumePendingChatgpt, publicStatus, readStore, updateStore } from "./credentials";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "vessel-creds-"));
  process.env.VESSEL_CREDENTIALS_PATH = path.join(dir, "nested", "credentials.json");
});
afterEach(async () => {
  delete process.env.VESSEL_CREDENTIALS_PATH;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("credential store", () => {
  it("starts empty with a stable opaque host id", async () => {
    const store = await readStore();
    expect(store.keys).toEqual({});
    expect(store.hostId).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
  });

  it("persists updates and keeps the host id", async () => {
    const first = await updateStore((s) => {
      s.keys.openai = { apiKey: "sk-secret-9876", verified: true, savedAt: "now" };
      return s.hostId;
    });
    const store = await readStore();
    expect(store.keys.openai?.apiKey).toBe("sk-secret-9876");
    expect(store.hostId).toBe(first);
  });

  it("never exposes raw secrets in public status", async () => {
    await updateStore((s) => {
      s.keys.anthropic = { apiKey: "sk-ant-secret-4321", verified: true, model: "m", savedAt: "now" };
      s.active = "anthropic";
    });
    const status = publicStatus(await readStore());
    expect(JSON.stringify(status)).not.toContain("sk-ant-secret");
    expect(status.keys.find((k) => k.id === "anthropic")).toMatchObject({ connected: true, keyHint: "…4321", model: "m" });
    expect(status.active).toBe("anthropic");
  });

  it("serializes concurrent updates without losing writes", async () => {
    await Promise.all(
      (["openai", "anthropic", "glm"] as const).map((id) =>
        updateStore((s) => {
          s.keys[id] = { apiKey: `key-${id}-0000`, verified: true, savedAt: "now" };
        }),
      ),
    );
    expect(Object.keys((await readStore()).keys).sort()).toEqual(["anthropic", "glm", "openai"]);
  });

  it("hands out a pending ChatGPT sign-in only once", async () => {
    await updateStore((s) => {
      s.pendingChatgpt = { state: "s", nonce: "n", verifier: "v", redirectUri: "http://127.0.0.1:3000/cb", expiresAt: Date.now() + 1000 };
    });
    expect((await consumePendingChatgpt())?.state).toBe("s");
    expect(await consumePendingChatgpt()).toBeUndefined();
  });

  it("refuses to overwrite a corrupt credentials file", async () => {
    await fs.mkdir(path.dirname(process.env.VESSEL_CREDENTIALS_PATH!), { recursive: true });
    await fs.writeFile(process.env.VESSEL_CREDENTIALS_PATH!, "{not json");
    await expect(readStore()).rejects.toThrow();
    await expect(updateStore(() => undefined)).rejects.toThrow();
    expect(await fs.readFile(process.env.VESSEL_CREDENTIALS_PATH!, "utf8")).toBe("{not json");
  });
});
