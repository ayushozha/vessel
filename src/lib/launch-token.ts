// Per-launch access token. A fresh token is written at server start (src/instrumentation.ts) to an owner-only
// file and printed to the terminal as a sign-in link. src/proxy.ts requires it, as a cookie or Bearer header,
// on every page and API request. Code running in project sandboxes cannot read the file (no host file access),
// so it cannot call Vessel's API even though it shares the machine's network.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const TOKEN_COOKIE = "vessel_session";

export const tokenPath = () =>
  process.env.VESSEL_TOKEN_PATH || path.join(process.env.VESSEL_HOME || path.join(os.homedir(), ".config", "vessel"), "launch-token");

export function createLaunchToken(): string {
  const token = randomBytes(32).toString("base64url");
  const file = tokenPath();
  mkdirSync(/*turbopackIgnore: true*/ path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(/*turbopackIgnore: true*/ file, token, { mode: 0o600 });
  return token;
}

export function readLaunchToken(): string | null {
  try {
    return readFileSync(/*turbopackIgnore: true*/ tokenPath(), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** Constant-time comparison; a missing token never matches. */
export function tokenMatches(candidate: string | null | undefined, expected: string | null): boolean {
  if (!candidate || !expected) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
