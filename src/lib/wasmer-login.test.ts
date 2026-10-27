import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readStore } from "./credentials";
import { createNonce, signupUrl, viewer } from "./wasmer";
import { cancelLogin, loginStatus, startLogin } from "./wasmer-login";

vi.mock("./wasmer", async (original) => ({
  ...(await original<typeof import("./wasmer")>()),
  createNonce: vi.fn(),
  viewer: vi.fn(),
}));

const ORIGIN = "https://wasmer.io";
let dir: string;
let callbackUrl: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "vessel-wl-"));
  process.env.VESSEL_CREDENTIALS_PATH = path.join(dir, "credentials.json");
  vi.mocked(createNonce).mockImplementation(async (_name, url) => {
    callbackUrl = url;
    return { id: "Tm9uY2U6MQ", secret: "s3cret", authUrl: `${ORIGIN}/auth/cli?nonce_id=Tm9uY2U6MQ&secret=s3cret` };
  });
});
afterEach(async () => {
  vi.clearAllMocks();
  delete process.env.VESSEL_CREDENTIALS_PATH;
  await fs.rm(dir, { recursive: true, force: true });
});

// What the wasmer.io /auth/cli page sends: the callback URL plus "/", JSON, from its own origin.
const post = (body: unknown, { origin = ORIGIN, url = `${callbackUrl}/` } = {}) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body) });

describe("Wasmer sign-in", () => {
  it("asks Wasmer for a nonce with a 127.0.0.1 callback and returns the auth and sign-up URLs", async () => {
    const start = await startLogin();
    expect(createNonce).toHaveBeenCalledWith("adorable", expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/wasmer\/[\w-]{32}$/));
    expect(start.authUrl).toBe(`${ORIGIN}/auth/cli?nonce_id=Tm9uY2U6MQ&secret=s3cret`);
    expect(start.signupUrl).toBe(signupUrl(start.authUrl));
    expect(new URL(start.signupUrl).searchParams.get("redirect")).toBe("/auth/cli?nonce_id=Tm9uY2U6MQ&secret=s3cret");
    expect(loginStatus(start.id)).toEqual({ state: "waiting" });
    cancelLogin(start.id);
  });

  it("answers the CORS preflight for wasmer.io, including Private Network Access", async () => {
    const start = await startLogin();
    const res = await fetch(`${callbackUrl}/`, {
      method: "OPTIONS",
      headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Private-Network": "true" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("access-control-allow-headers")).toBe("Content-Type");
    expect(res.headers.get("access-control-allow-private-network")).toBe("true");
    cancelLogin(start.id);
  });

  it("verifies the token with Wasmer, links the account and closes the listener", async () => {
    vi.mocked(viewer).mockResolvedValue({ username: "ada", email: "ada@example.com" });
    const start = await startLogin();
    const res = await post({ token: "wap_token", status: "authorized" });
    expect(res.status).toBe(200);
    expect(viewer).toHaveBeenCalledWith("wap_token");
    expect(loginStatus(start.id)).toEqual({ state: "connected", username: "ada" });
    expect((await readStore()).wasmer).toMatchObject({ token: "wap_token", username: "ada", email: "ada@example.com" });
    await expect(post({ token: "again", status: "authorized" })).rejects.toThrow(); // listener is gone
  });

  it("records a decline on wasmer.io without saving anything", async () => {
    const start = await startLogin();
    expect((await post({ status: "cancelled" })).status).toBe(200);
    expect(loginStatus(start.id)).toEqual({ state: "cancelled" });
    expect((await readStore()).wasmer).toBeUndefined();
  });

  it("fails when Wasmer does not accept the token", async () => {
    vi.mocked(viewer).mockResolvedValue(null);
    const start = await startLogin();
    expect((await post({ token: "bad", status: "authorized" })).status).toBe(502);
    expect(loginStatus(start.id)?.state).toBe("failed");
    expect((await readStore()).wasmer).toBeUndefined();
  });

  it("refuses other origins and other paths, and keeps waiting", async () => {
    const start = await startLogin();
    expect((await post({ token: "t", status: "authorized" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ token: "t", status: "authorized" }, { url: callbackUrl.replace(/\/wasmer\/.*/, "/wasmer/guess/") })).status).toBe(404);
    expect(viewer).not.toHaveBeenCalled();
    expect(loginStatus(start.id)).toEqual({ state: "waiting" });
    cancelLogin(start.id);
  });

  it("abandons an earlier sign-in when a new one starts", async () => {
    const first = await startLogin();
    const second = await startLogin();
    expect(loginStatus(first.id)).toEqual({ state: "cancelled" });
    expect(loginStatus(second.id)).toEqual({ state: "waiting" });
    cancelLogin(second.id);
  });
});
