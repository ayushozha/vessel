import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it } from "vitest";

import { checkCallback, localModeError, parseScopes, verifyIdToken } from "./chatgpt";
import type { PendingChatgpt } from "./credentials";

const pending = (over: Partial<PendingChatgpt> = {}): PendingChatgpt => ({
  state: "state-1",
  nonce: "nonce-1",
  verifier: "verifier",
  redirectUri: "http://127.0.0.1:3000/api/chatgpt/callback",
  expiresAt: Date.now() + 60_000,
  ...over,
});
const params = (p: Record<string, string>) => new URLSearchParams(p);

describe("checkCallback", () => {
  const good = { state: "state-1", code: "code-1", client_id: "oaiapp_123" };

  it("accepts a new registration and returns the issued client id", () => {
    expect(checkCallback(params(good), pending())).toEqual({ ok: true, clientId: "oaiapp_123" });
  });

  it("rejects missing, expired or mismatched sign-ins before anything else", () => {
    expect(checkCallback(params(good), undefined)).toMatchObject({ reason: "no_pending_sign_in" });
    expect(checkCallback(params(good), pending({ expiresAt: Date.now() - 1 }))).toMatchObject({ reason: "sign_in_expired" });
    // A forged callback carrying an error must still fail on state first.
    expect(checkCallback(params({ state: "evil", error: "access_denied" }), pending())).toMatchObject({ reason: "state_mismatch" });
  });

  it("stops on declined consent and other OAuth errors", () => {
    expect(checkCallback(params({ state: "state-1", error: "access_denied" }), pending())).toMatchObject({ reason: "access_denied" });
    expect(checkCallback(params({ state: "state-1", error: "server_error" }), pending())).toMatchObject({ reason: "oauth_error" });
  });

  it("requires an issued client id on first registration", () => {
    expect(checkCallback(params({ state: "state-1", code: "c" }), pending())).toMatchObject({ reason: "registration_incomplete" });
    expect(checkCallback(params({ state: "state-1", code: "c", client_id: "dynamic_agent_client" }), pending())).toMatchObject({
      reason: "registration_incomplete",
    });
  });

  it("keeps the original client id on reauthorization and rejects a different one", () => {
    const re = pending({ clientId: "oaiapp_original" });
    expect(checkCallback(params({ state: "state-1", code: "c" }), re)).toEqual({ ok: true, clientId: "oaiapp_original" });
    expect(checkCallback(params({ state: "state-1", code: "c", client_id: "oaiapp_other" }), re)).toMatchObject({ reason: "client_mismatch" });
  });

  it("requires a code", () => {
    expect(checkCallback(params({ state: "state-1", client_id: "oaiapp_1" }), pending())).toMatchObject({ reason: "missing_code" });
  });
});

describe("verifyIdToken", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" }] });
  const sign = (claims: Record<string, unknown>, key = privateKey) =>
    new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuedAt().setExpirationTime("5m").sign(key);
  const opts = { jwks, issuer: "https://auth.openai.com", audience: "oaiapp_1", nonce: "n1" };
  const base = { iss: "https://auth.openai.com", aud: "oaiapp_1", nonce: "n1", sub: "user-1", email: "a@b.c" };

  it("accepts a correctly signed token", async () => {
    expect(await verifyIdToken(await sign(base), opts)).toMatchObject({ sub: "user-1", email: "a@b.c" });
  });

  it("rejects wrong audience, issuer, nonce, missing sub and foreign signatures", async () => {
    await expect(verifyIdToken(await sign({ ...base, aud: "someone-else" }), opts)).rejects.toThrow();
    await expect(verifyIdToken(await sign({ ...base, iss: "https://evil.example" }), opts)).rejects.toThrow();
    await expect(verifyIdToken(await sign({ ...base, nonce: "other" }), opts)).rejects.toThrow("nonce_mismatch");
    await expect(verifyIdToken(await sign({ ...base, sub: undefined }), opts)).rejects.toThrow("missing_sub");
    const other = await generateKeyPair("RS256");
    await expect(verifyIdToken(await sign(base, other.privateKey), opts)).rejects.toThrow();
  });
});

describe("parseScopes", () => {
  it("handles array and space-separated forms", () => {
    expect(parseScopes({ scopes: ["openid", "chatgpt.tokens.use.direct"] })).toEqual(["openid", "chatgpt.tokens.use.direct"]);
    expect(parseScopes({ scope: "openid email" })).toEqual(["openid", "email"]);
    expect(parseScopes({})).toEqual([]);
  });
});

describe("localModeError", () => {
  afterEach(() => {
    delete process.env.CHATGPT_LOCAL_MODE;
  });

  it("is off unless explicitly enabled", () => {
    expect(localModeError("http://127.0.0.1:3000/x")).toMatch(/CHATGPT_LOCAL_MODE/);
  });

  it("requires 127.0.0.1, not localhost", () => {
    process.env.CHATGPT_LOCAL_MODE = "true";
    expect(localModeError("http://localhost:3000/x")).toMatch(/127\.0\.0\.1/);
    expect(localModeError("http://127.0.0.1:3000/x")).toBeNull();
  });
});

describe("isSessionExpired", () => {
  it("only treats revoked or replaced sessions as expired", async () => {
    const { isSessionExpired } = await import("./chatgpt");
    expect(isSessionExpired({ error: "invalid_grant" })).toBe(true);
    expect(isSessionExpired(new Error("account_changed_during_refresh"))).toBe(true);
    expect(isSessionExpired(new TypeError("fetch failed"))).toBe(false);
    expect(isSessionExpired(null)).toBe(false);
  });
});
