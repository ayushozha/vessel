// Sign in with Wasmer, the same way `wasmer login` does. Server-only.
//
// 1. Adorable opens a one-shot listener on a random 127.0.0.1 port, at a path holding an unguessable id.
// 2. It asks Wasmer for a nonce with that listener as the callback and sends the user to the nonce's authUrl
//    (wasmer.io/auth/cli). wasmer.io sends signed-out visitors through log in or sign up first, so a new user
//    creates their Wasmer account right there.
// 3. When the user authorizes, the wasmer.io page POSTs { status, token } to the callback (CORS, from its own
//    origin). Adorable checks the token with Wasmer's `viewer` query and stores it with the account.
//
// The listener is separate from the Next server because wasmer.io cannot present Adorable's launch token.
import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { updateStore } from "./credentials";
import { createNonce, registryUrl, signupUrl, viewer, WasmerError } from "./wasmer";

export type LoginState = "waiting" | "connected" | "cancelled" | "expired" | "failed";
export type LoginStatus = { state: LoginState; username?: string; error?: string };

/** Name of the token in the user's Wasmer token list (a slug of at least 3 characters). */
const TOKEN_NAME = "adorable";
const LOGIN_TTL_MS = 10 * 60_000;
const MAX_BODY = 64 * 1024;

type Login = { id: string; status: LoginStatus; allowedOrigin: string; server: http.Server; timer: NodeJS.Timeout };

const g = globalThis as typeof globalThis & { __vesselWasmerLogins?: Map<string, Login> };
const logins = (g.__vesselWasmerLogins ??= new Map());

/** Begin a sign-in. Any earlier sign-in that is still waiting is abandoned. */
export async function startLogin(): Promise<{ id: string; authUrl: string; signupUrl: string }> {
  for (const login of logins.values()) if (login.status.state === "waiting") finish(login, { state: "cancelled" });

  const id = randomBytes(24).toString("base64url");
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;

  let nonce;
  try {
    nonce = await createNonce(TOKEN_NAME, `http://127.0.0.1:${port}/wasmer/${id}`);
  } catch (e) {
    server.close();
    throw e;
  }

  const login: Login = {
    id,
    status: { state: "waiting" },
    allowedOrigin: new URL(nonce.authUrl).origin,
    server,
    timer: setTimeout(() => finish(login, { state: "expired", error: "That sign-in took longer than 10 minutes. Start again." }), LOGIN_TTL_MS),
  };
  login.timer.unref();
  server.on("request", (req, res) => void handleCallback(login, req, res));
  logins.set(id, login);
  return { id, authUrl: nonce.authUrl, signupUrl: signupUrl(nonce.authUrl) };
}

export function loginStatus(id: string): LoginStatus | null {
  return logins.get(id)?.status ?? null;
}

export function cancelLogin(id: string): void {
  const login = logins.get(id);
  if (login?.status.state === "waiting") finish(login, { state: "cancelled" });
}

function finish(login: Login, status: LoginStatus) {
  if (login.status.state !== "waiting") return;
  login.status = status;
  clearTimeout(login.timer);
  login.server.close();
  login.server.closeIdleConnections();
  // Keep the outcome around long enough for the UI's next poll, then forget it.
  setTimeout(() => logins.delete(login.id), 60_000).unref();
}

/** Answers wasmer.io's preflight and its single POST; everything else is refused. */
async function handleCallback(login: Login, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const reply = (status: number, body?: object) => {
    res.writeHead(status, body ? { "Content-Type": "application/json" } : {});
    res.end(body ? JSON.stringify(body) : undefined);
  };

  // wasmer.io appends a "/" to the callback URL.
  const path = (req.url ?? "").split("?")[0].replace(/\/$/, "");
  if (path !== `/wasmer/${login.id}`) return reply(404);

  const origin = req.headers.origin;
  if (origin !== login.allowedOrigin) return reply(403);
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");

  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    // Chrome asks before a public site may call a loopback address.
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    return reply(204);
  }
  if (req.method !== "POST") return reply(405);
  if (login.status.state !== "waiting") return reply(409, { error: "This sign-in is already finished." });

  let body: { status?: unknown; token?: unknown };
  try {
    body = JSON.parse((await readBody(req)).toString("utf8"));
  } catch {
    return reply(400, { error: "Invalid request." });
  }

  if (body.status === "cancelled") {
    finish(login, { state: "cancelled" });
    return reply(200, { ok: true });
  }
  if (body.status !== "authorized" || typeof body.token !== "string" || !body.token) return reply(400, { error: "Invalid request." });

  const token = body.token;
  try {
    const user = await viewer(token);
    if (!user) throw new WasmerError("Wasmer did not accept the token it issued. Try signing in again.");
    await updateStore((s) => {
      s.wasmer = { token, username: user.username, email: user.email, registry: registryUrl(), savedAt: new Date().toISOString() };
    });
    reply(200, { ok: true });
    finish(login, { state: "connected", username: user.username });
  } catch (e) {
    const error = e instanceof WasmerError ? e.message : "The Wasmer account could not be saved.";
    if (!(e instanceof WasmerError)) console.error(e);
    reply(502, { error });
    finish(login, { state: "failed", error });
  }
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
