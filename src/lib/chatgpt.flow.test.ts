// Token exchange, account checks and refresh, with OpenAI's endpoints mocked.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import * as oauth from "oauth4webapi";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ jwks: null as unknown as JWTVerifyGetKey }));

vi.mock("jose", async (original) => ({
  ...(await original<typeof import("jose")>()),
  createRemoteJWKSet: () => ((...args: Parameters<JWTVerifyGetKey>) => h.jwks(...args)) as JWTVerifyGetKey,
}));

vi.mock("oauth4webapi", async (original) => ({
  ...(await original<typeof import("oauth4webapi")>()),
  discoveryRequest: vi.fn(async () => new Response("{}")),
  processDiscoveryResponse: vi.fn(async () => ({
    issuer: "https://auth.openai.com",
    authorization_endpoint: "https://auth.openai.com/api/accounts/authorize",
    token_endpoint: "https://auth.openai.com/api/accounts/oauth/token",
    jwks_uri: "https://auth.openai.com/.well-known/jwks.json",
  })),
  authorizationCodeGrantRequest: vi.fn(async () => new Response("{}")),
  processAuthorizationCodeResponse: vi.fn(),
  refreshTokenGrantRequest: vi.fn(async () => new Response("{}")),
  processRefreshTokenResponse: vi.fn(),
}));

const { completeAuthorization, getChatgptAccessToken } = await import("./chatgpt");
const { readStore, updateStore } = await import("./credentials");

let signIdToken: (claims: Record<string, unknown>) => Promise<string>;
beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  h.jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" }] });
  signIdToken = (claims) =>
    new SignJWT({ iss: "https://auth.openai.com", aud: "oaiapp_1", nonce: "n1", ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
});

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "vessel-flow-"));
  process.env.VESSEL_CREDENTIALS_PATH = path.join(dir, "credentials.json");
});
afterEach(async () => {
  vi.clearAllMocks();
  delete process.env.VESSEL_CREDENTIALS_PATH;
  await fs.rm(dir, { recursive: true, force: true });
});

const PLAN_SCOPE = "openid email offline_access chatgpt.tokens.use.direct";
const pending = { state: "s1", nonce: "n1", verifier: "v", redirectUri: "http://127.0.0.1:3000/api/chatgpt/callback", expiresAt: Date.now() + 60_000 };
const callback = new URL("http://127.0.0.1:3000/api/chatgpt/callback?state=s1&code=c1&client_id=oaiapp_1");
const tokens = async (claims: Record<string, unknown>, scope = PLAN_SCOPE) =>
  vi.mocked(oauth.processAuthorizationCodeResponse).mockResolvedValue({
    access_token: "access-1",
    refresh_token: "refresh-1",
    expires_in: 3600,
    token_type: "bearer",
    scope,
    id_token: await signIdToken(claims),
  } as oauth.TokenEndpointResponse);

const saveChatgpt = (over: Record<string, unknown> = {}) =>
  updateStore((s) => {
    s.chatgpt = {
      clientId: "oaiapp_1",
      sub: "user-alice",
      idToken: "old-id",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: Date.now() + 10 * 60_000,
      scopes: [PLAN_SCOPE],
      savedAt: "then",
      ...over,
    };
  });

describe("completeAuthorization", () => {
  it("stores verified tokens, sends the resource parameter and makes ChatGPT active", async () => {
    await tokens({ sub: "user-alice", email: "alice@example.com" });
    await completeAuthorization(callback, pending, "oaiapp_1");

    const store = await readStore();
    expect(store.chatgpt).toMatchObject({ clientId: "oaiapp_1", sub: "user-alice", email: "alice@example.com", accessToken: "access-1", refreshToken: "refresh-1" });
    expect(store.active).toBe("chatgpt");
    const [, , , , redirectUri, verifier, options] = vi.mocked(oauth.authorizationCodeGrantRequest).mock.calls[0];
    expect([redirectUri, verifier]).toEqual([pending.redirectUri, "v"]);
    expect(options?.additionalParameters).toEqual({ resource: "https://api.openai.com/v1" });
  });

  it("refuses to replace an account with a different one under the same client", async () => {
    await saveChatgpt();
    await tokens({ sub: "user-bob" });
    await expect(completeAuthorization(callback, pending, "oaiapp_1")).rejects.toThrow("account_mismatch");
    expect((await readStore()).chatgpt?.sub).toBe("user-alice");
  });

  it("refuses sign-ins that did not grant ChatGPT plan usage", async () => {
    await tokens({ sub: "user-alice" }, "openid email");
    await expect(completeAuthorization(callback, pending, "oaiapp_1")).rejects.toThrow("plan_usage_not_granted");
    expect((await readStore()).chatgpt).toBeUndefined();
  });

  it("rejects an ID token issued for another client", async () => {
    await tokens({ sub: "user-alice", aud: "oaiapp_other" });
    await expect(completeAuthorization(callback, pending, "oaiapp_1")).rejects.toThrow();
    expect((await readStore()).chatgpt).toBeUndefined();
  });
});

describe("getChatgptAccessToken", () => {
  it("returns null when ChatGPT is not connected", async () => {
    expect(await getChatgptAccessToken()).toBeNull();
  });

  it("returns the stored token while it has more than a minute left", async () => {
    await saveChatgpt();
    expect(await getChatgptAccessToken()).toBe("old-access");
    expect(oauth.refreshTokenGrantRequest).not.toHaveBeenCalled();
  });

  it("refreshes near expiry and rotates the refresh token", async () => {
    await saveChatgpt({ expiresAt: Date.now() + 30_000 });
    vi.mocked(oauth.processRefreshTokenResponse).mockResolvedValue({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
      token_type: "bearer",
    } as oauth.TokenEndpointResponse);

    expect(await getChatgptAccessToken()).toBe("new-access");
    const [, , , refreshToken, options] = vi.mocked(oauth.refreshTokenGrantRequest).mock.calls[0];
    expect(refreshToken).toBe("old-refresh");
    expect(options?.additionalParameters).toEqual({ resource: "https://api.openai.com/v1" });
    const saved = (await readStore()).chatgpt!;
    expect(saved).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh", scopes: [PLAN_SCOPE] });
    expect(saved.expiresAt).toBeGreaterThan(Date.now() + 50 * 60_000);
  });

  it("returns null when the token expired and there is no refresh token", async () => {
    await saveChatgpt({ expiresAt: Date.now() - 1, refreshToken: undefined });
    expect(await getChatgptAccessToken()).toBeNull();
  });

  it("propagates refresh failures so callers can ask the user to reconnect", async () => {
    await saveChatgpt({ expiresAt: Date.now() - 1 });
    vi.mocked(oauth.processRefreshTokenResponse).mockRejectedValue(new Error("invalid_grant"));
    await expect(getChatgptAccessToken()).rejects.toThrow("invalid_grant");
    expect((await readStore()).chatgpt?.accessToken).toBe("old-access");
  });
});
