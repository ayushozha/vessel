import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLaunchToken, readLaunchToken, TOKEN_COOKIE, tokenMatches } from "./lib/launch-token";
import { proxy } from "./proxy";

let dir: string;
let token: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "vessel-token-"));
  process.env.VESSEL_TOKEN_PATH = path.join(dir, "nested", "launch-token");
  token = createLaunchToken();
});
afterEach(async () => {
  delete process.env.VESSEL_TOKEN_PATH;
  await fs.rm(dir, { recursive: true, force: true });
});

const req = (url: string, headers: Record<string, string> = {}) =>
  new NextRequest(new Request(`http://127.0.0.1:3000${url}`, { headers: { host: "127.0.0.1:3000", ...headers } }));

describe("launch token", () => {
  it("creates a fresh, unguessable token per launch and reads it back", () => {
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(readLaunchToken()).toBe(token);
    expect(createLaunchToken()).not.toBe(token);
  });

  it("compares in constant time and never matches a missing token", () => {
    expect(tokenMatches(token, token)).toBe(true);
    expect(tokenMatches(token.slice(0, -1) + "x", token)).toBe(false);
    expect(tokenMatches("short", token)).toBe(false);
    expect(tokenMatches(undefined, token)).toBe(false);
    expect(tokenMatches(token, null)).toBe(false);
    expect(tokenMatches("", "")).toBe(false);
  });
});

describe("proxy", () => {
  it("blocks pages and API calls without the token", async () => {
    const page = proxy(req("/onboarding"));
    expect(page.status).toBe(401);
    expect(await page.text()).toContain("Open Vessel from your terminal");
    const api = proxy(req("/api/providers"));
    expect(api.status).toBe(401);
    expect((await api.json()).error).toMatch(/sign-in link/);
  });

  it("signs in through the printed link: sets an httpOnly, SameSite=Lax cookie and redirects home", () => {
    const res = proxy(req(`/auth?token=${token}`));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://127.0.0.1:3000/");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${TOKEN_COOKIE}=${token}`);
    expect(cookie.toLowerCase()).toContain("httponly");
    expect(cookie.toLowerCase()).toContain("samesite=lax");
  });

  it("rejects a wrong or missing sign-in token", () => {
    expect(proxy(req("/auth?token=nope")).status).toBe(401);
    expect(proxy(req("/auth")).status).toBe(401);
  });

  it("lets requests through with the cookie or a Bearer header", () => {
    expect(proxy(req("/build/x", { cookie: `${TOKEN_COOKIE}=${token}` })).headers.get("x-middleware-next")).toBe("1");
    expect(proxy(req("/api/providers", { authorization: `Bearer ${token}` })).headers.get("x-middleware-next")).toBe("1");
    expect(proxy(req("/api/providers", { cookie: `${TOKEN_COOKIE}=stale` })).status).toBe(401);
  });

  it("serves only the landing page without a token", () => {
    expect(proxy(req("/")).headers.get("x-middleware-next")).toBe("1");
    expect(proxy(req("/landing.html")).headers.get("x-middleware-next")).toBe("1");
    expect(proxy(req("/onboarding")).status).toBe(401);
    expect(proxy(req("/landing.html/../api/providers")).status).toBe(401);
    expect(proxy(req("/api/projects")).status).toBe(401);
  });

  it("locks everything if no token exists yet", async () => {
    await fs.rm(process.env.VESSEL_TOKEN_PATH!);
    expect(proxy(req("/api/providers", { authorization: "Bearer " })).status).toBe(401);
    expect(proxy(req("/auth?token=")).status).toBe(401);
  });
});
