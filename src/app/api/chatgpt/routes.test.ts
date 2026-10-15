import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { completeAuthorization, createAuthorization } from "@/lib/chatgpt";
import { readStore, updateStore } from "@/lib/credentials";

import { GET as callback } from "./callback/route";
import { GET as start } from "./start/route";

vi.mock("@/lib/chatgpt", async (original) => ({
  ...(await original<typeof import("@/lib/chatgpt")>()),
  createAuthorization: vi.fn(),
  completeAuthorization: vi.fn(),
}));

const get = (url: string) => new Request(url, { headers: { host: new URL(url).host } });
const location = (res: Response) => res.headers.get("location");

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "vessel-cg-"));
  process.env.VESSEL_CREDENTIALS_PATH = path.join(dir, "credentials.json");
  process.env.CHATGPT_LOCAL_MODE = "true";
});
afterEach(async () => {
  vi.clearAllMocks();
  delete process.env.CHATGPT_LOCAL_MODE;
  delete process.env.VESSEL_CREDENTIALS_PATH;
  await fs.rm(dir, { recursive: true, force: true });
});

const savePending = (over: Record<string, unknown> = {}) =>
  updateStore((s) => {
    s.pendingChatgpt = { state: "s1", nonce: "n1", verifier: "v", redirectUri: "http://127.0.0.1:3000/api/chatgpt/callback", expiresAt: Date.now() + 60_000, ...over };
  });

describe("/api/chatgpt/start", () => {
  it("redirects to OpenAI with a 127.0.0.1 callback on the current port", async () => {
    vi.mocked(createAuthorization).mockResolvedValue(new URL("https://auth.openai.com/api/accounts/authorize?x=1"));
    const res = await start(get("http://127.0.0.1:4123/api/chatgpt/start"));
    expect(res.status).toBe(303);
    expect(location(res)).toBe("https://auth.openai.com/api/accounts/authorize?x=1");
    expect(createAuthorization).toHaveBeenCalledWith("http://127.0.0.1:4123/api/chatgpt/callback");
  });

  it("does not start when local mode is off or the host is localhost", async () => {
    delete process.env.CHATGPT_LOCAL_MODE;
    expect(location(await start(get("http://127.0.0.1:3000/api/chatgpt/start")))).toBe("http://127.0.0.1:3000/onboarding?chatgpt=unavailable");
    process.env.CHATGPT_LOCAL_MODE = "true";
    expect(location(await start(get("http://localhost:3000/api/chatgpt/start")))).toBe("http://localhost:3000/onboarding?chatgpt=unavailable");
    expect(createAuthorization).not.toHaveBeenCalled();
  });

  it("reports an unreachable OpenAI instead of throwing", async () => {
    vi.mocked(createAuthorization).mockRejectedValue(new TypeError("fetch failed"));
    expect(location(await start(get("http://127.0.0.1:3000/api/chatgpt/start")))).toBe("http://127.0.0.1:3000/onboarding?chatgpt=unreachable");
  });
});

describe("/api/chatgpt/callback", () => {
  const url = "http://127.0.0.1:3000/api/chatgpt/callback?state=s1&code=c1&client_id=oaiapp_1";

  it("completes a valid sign-in once and consumes the pending transaction", async () => {
    await savePending();
    const res = await callback(get(url));
    expect(location(res)).toBe("http://127.0.0.1:3000/onboarding?chatgpt=connected");
    expect(completeAuthorization).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ state: "s1" }), "oaiapp_1");
    expect((await readStore()).pendingChatgpt).toBeUndefined();

    // Replaying the same callback finds nothing to complete.
    expect(location(await callback(get(url)))).toBe("http://127.0.0.1:3000/onboarding?chatgpt=no_pending_sign_in");
    expect(completeAuthorization).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a forged state", "?state=evil&code=c1&client_id=oaiapp_1", {}, "state_mismatch"],
    ["declined consent", "?state=s1&error=access_denied", {}, "access_denied"],
    ["an expired sign-in", "?state=s1&code=c1&client_id=oaiapp_1", { expiresAt: Date.now() - 1 }, "sign_in_expired"],
    ["a missing code", "?state=s1&client_id=oaiapp_1", {}, "missing_code"],
  ])("rejects %s without exchanging a code", async (_, query, over, reason) => {
    await savePending(over);
    expect(location(await callback(get(`http://127.0.0.1:3000/api/chatgpt/callback${query}`)))).toBe(
      `http://127.0.0.1:3000/onboarding?chatgpt=${reason}`,
    );
    expect(completeAuthorization).not.toHaveBeenCalled();
    expect((await readStore()).pendingChatgpt).toBeUndefined();
  });

  it("passes known failure codes through and hides other error text", async () => {
    await savePending();
    vi.mocked(completeAuthorization).mockRejectedValueOnce(new Error("account_mismatch"));
    expect(location(await callback(get(url)))).toBe("http://127.0.0.1:3000/onboarding?chatgpt=account_mismatch");

    await savePending();
    vi.mocked(completeAuthorization).mockRejectedValueOnce(new Error("token endpoint said: secret detail"));
    expect(location(await callback(get(url)))).toBe("http://127.0.0.1:3000/onboarding?chatgpt=exchange_failed");
  });
});
