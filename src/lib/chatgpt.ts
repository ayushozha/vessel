// ChatGPT plan usage via Sign in with ChatGPT, local/open-source flow only.
// Docs: https://developers.openai.com/siwc/token-sharing-open-source/sign-in
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import * as oauth from "oauth4webapi";

import { readStore, updateStore, type ChatgptCredential, type PendingChatgpt } from "./credentials";

export const ISSUER = new URL("https://auth.openai.com");
export const RESOURCE = "https://api.openai.com/v1";
export const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
export const REQUIRED_SCOPE = "chatgpt.tokens.use.direct";
export const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
export const AGENT_NAME = "Vessel";
const TX_TTL_MS = 10 * 60_000;

/** Local mode is opt-in and only works on 127.0.0.1, which OpenAI requires for the loopback callback. */
export function localModeError(requestUrl: string): string | null {
  if (process.env.CHATGPT_LOCAL_MODE !== "true")
    return "ChatGPT local mode is off. Set CHATGPT_LOCAL_MODE=true in .env.local and restart.";
  if (new URL(requestUrl).hostname !== "127.0.0.1")
    return "Open Vessel at http://127.0.0.1:3000. OpenAI only redirects back to 127.0.0.1.";
  return null;
}

let authServer: Promise<oauth.AuthorizationServer> | undefined;
export function getAuthServer() {
  authServer ??= oauth
    .discoveryRequest(ISSUER)
    .then((res) => oauth.processDiscoveryResponse(ISSUER, res))
    .catch((e) => {
      authServer = undefined;
      throw e;
    });
  return authServer;
}

let remoteJwks: JWTVerifyGetKey | undefined;
const getJwks = (as: oauth.AuthorizationServer) => (remoteJwks ??= createRemoteJWKSet(new URL(as.jwks_uri!)));

export async function createAuthorization(redirectUri: string) {
  const as = await getAuthServer();
  const store = await readStore();
  const existing = store.chatgpt;
  const pending: PendingChatgpt = {
    state: oauth.generateRandomState(),
    nonce: oauth.generateRandomNonce(),
    verifier: oauth.generateRandomCodeVerifier(),
    redirectUri,
    clientId: existing?.clientId,
    expiresAt: Date.now() + TX_TTL_MS,
  };
  const url = new URL(as.authorization_endpoint!);
  const p = url.searchParams;
  p.set("client_id", existing?.clientId ?? DYNAMIC_CLIENT_ID);
  if (existing) {
    p.set("id_token_hint", existing.idToken);
    if (existing.email) p.set("login_hint", existing.email);
  } else {
    p.set("agent_name_hint", AGENT_NAME);
  }
  p.set("ext_agent_host_id", store.hostId);
  p.set("response_type", "code");
  p.set("redirect_uri", redirectUri);
  p.set("scope", SCOPES);
  p.set("resource", RESOURCE);
  p.set("state", pending.state);
  p.set("nonce", pending.nonce);
  p.set("code_challenge_method", "S256");
  p.set("code_challenge", await oauth.calculatePKCECodeChallenge(pending.verifier));
  await updateStore((s) => {
    s.pendingChatgpt = pending;
  });
  return url;
}

export type CallbackCheck = { ok: true; clientId: string } | { ok: false; reason: string };

/** Pure checks on the callback, in the order the docs require: state first, then errors, then client id. */
export function checkCallback(params: URLSearchParams, pending: PendingChatgpt | undefined, now = Date.now()): CallbackCheck {
  if (!pending) return { ok: false, reason: "no_pending_sign_in" };
  if (pending.expiresAt < now) return { ok: false, reason: "sign_in_expired" };
  if (params.get("state") !== pending.state) return { ok: false, reason: "state_mismatch" };
  const error = params.get("error");
  if (error === "access_denied") return { ok: false, reason: "access_denied" };
  if (error) return { ok: false, reason: "oauth_error" };
  const issued = params.get("client_id");
  if (pending.clientId) {
    if (issued && issued !== pending.clientId) return { ok: false, reason: "client_mismatch" };
  } else if (!issued || issued === DYNAMIC_CLIENT_ID) {
    return { ok: false, reason: "registration_incomplete" };
  }
  if (!params.get("code")) return { ok: false, reason: "missing_code" };
  return { ok: true, clientId: pending.clientId ?? issued! };
}

export function parseScopes(tokens: object): string[] {
  const raw = (tokens as { scopes?: unknown; scope?: unknown }).scopes ?? (tokens as { scope?: unknown }).scope;
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === "string");
  return typeof raw === "string" ? raw.split(" ").filter(Boolean) : [];
}

/** Full signature + claim verification; oauth4webapi does not check ID token signatures from the token endpoint. */
export async function verifyIdToken(
  idToken: string,
  { jwks, issuer, audience, nonce }: { jwks: JWTVerifyGetKey; issuer: string; audience: string; nonce?: string },
): Promise<JWTPayload & { sub: string }> {
  const { payload } = await jwtVerify(idToken, jwks, { issuer, audience });
  if (nonce !== undefined && payload.nonce !== nonce) throw new Error("nonce_mismatch");
  if (!payload.sub) throw new Error("missing_sub");
  return payload as JWTPayload & { sub: string };
}

export async function completeAuthorization(callbackUrl: URL, pending: PendingChatgpt, clientId: string) {
  const as = await getAuthServer();
  const client: oauth.Client = { client_id: clientId };
  const params = oauth.validateAuthResponse(as, client, callbackUrl.searchParams, pending.state);
  const res = await oauth.authorizationCodeGrantRequest(as, client, oauth.None(), params, pending.redirectUri, pending.verifier, {
    additionalParameters: { resource: RESOURCE },
  });
  const tokens = await oauth.processAuthorizationCodeResponse(as, client, res, {
    expectedNonce: pending.nonce,
    requireIdToken: true,
  });
  const claims = await verifyIdToken(tokens.id_token!, { jwks: getJwks(as), issuer: as.issuer, audience: clientId, nonce: pending.nonce });
  const scopes = parseScopes(tokens);
  if (!scopes.includes(REQUIRED_SCOPE)) throw new Error("plan_usage_not_granted");

  return updateStore((s) => {
    if (s.chatgpt && s.chatgpt.clientId === clientId && s.chatgpt.sub !== claims.sub) throw new Error("account_mismatch");
    const cred: ChatgptCredential = {
      clientId,
      sub: claims.sub,
      email: typeof claims.email === "string" ? claims.email : undefined,
      idToken: tokens.id_token!,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      scopes,
      model: s.chatgpt?.sub === claims.sub ? s.chatgpt.model : undefined,
      savedAt: new Date().toISOString(),
    };
    s.chatgpt = cred;
    s.active ??= "chatgpt";
    return cred;
  });
}

/** True when the stored ChatGPT session can no longer be refreshed and the user must connect again. */
export function isSessionExpired(e: unknown): boolean {
  const code = (e as { error?: unknown } | null)?.error ?? (e instanceof Error ? e.message : undefined);
  return code === "invalid_grant" || code === "account_changed_during_refresh";
}

/** Returns a usable access token, refreshing (and rotating the refresh token) when it is about to expire. */
export async function getChatgptAccessToken(): Promise<string | null> {
  const cred = (await readStore()).chatgpt;
  if (!cred) return null;
  if (cred.expiresAt - 60_000 > Date.now()) return cred.accessToken;
  if (!cred.refreshToken) return null;
  // Refresh tokens rotate, so concurrent callers must share one refresh instead of racing with a spent token.
  inflightRefresh ??= refresh(cred, cred.refreshToken).finally(() => {
    inflightRefresh = undefined;
  });
  return inflightRefresh;
}

let inflightRefresh: Promise<string> | undefined;

async function refresh(cred: ChatgptCredential, refreshToken: string): Promise<string> {
  const as = await getAuthServer();
  const client: oauth.Client = { client_id: cred.clientId };
  const res = await oauth.refreshTokenGrantRequest(as, client, oauth.None(), refreshToken, {
    additionalParameters: { resource: RESOURCE },
  });
  const tokens = await oauth.processRefreshTokenResponse(as, client, res);
  const updated = await updateStore((s) => {
    if (!s.chatgpt || s.chatgpt.sub !== cred.sub) throw new Error("account_changed_during_refresh");
    Object.assign(s.chatgpt, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? s.chatgpt.refreshToken,
      expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      scopes: parseScopes(tokens).length ? parseScopes(tokens) : s.chatgpt.scopes,
      ...(tokens.id_token ? { idToken: tokens.id_token } : {}),
    });
    return s.chatgpt;
  });
  return updated.accessToken;
}
