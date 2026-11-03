// Wasmer's GraphQL API (the registry endpoint the dashboard and the `wasmer` CLI use). Server-only.
// Tokens never leave the server; routes return only the account's username and email.

export const registryUrl = () => process.env.WASMER_REGISTRY || "https://registry.wasmer.io/graphql";

export class WasmerError extends Error {}

export async function graphql<T>(query: string, variables: Record<string, unknown> = {}, token?: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(registryUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }) },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new WasmerError("Could not reach Wasmer. Check your connection and try again.");
  }
  const body = (await res.json().catch(() => null)) as { data?: T; errors?: { message: string }[] } | null;
  if (body?.errors?.length) throw new WasmerError(body.errors[0].message);
  if (!res.ok || !body?.data) throw new WasmerError(`Wasmer answered ${res.status}.`);
  return body.data;
}

export type Nonce = { id: string; secret: string; authUrl: string };

/**
 * Start a `wasmer login` style authorization. wasmer.io only accepts a localhost or 127.0.0.1 callback with a
 * port. `secret` and `authUrl` can each be read once, so both come back from this one call.
 */
export async function createNonce(name: string, callbackUrl: string): Promise<Nonce> {
  const data = await graphql<{ newNonce: { nonce: Nonce } }>(
    `mutation NewNonce($input: NewNonceInput!) { newNonce(input: $input) { nonce { id secret authUrl } } }`,
    { input: { name, callbackUrl } },
  );
  return data.newNonce.nonce;
}

export type WasmerUser = { username: string; email?: string };

/** The account behind a token, or null when Wasmer does not accept it. */
export async function viewer(token: string): Promise<WasmerUser | null> {
  const data = await graphql<{ viewer: { username: string; email: string | null } | null }>(`query Viewer { viewer { username email } }`, {}, token);
  return data.viewer ? { username: data.viewer.username, email: data.viewer.email || undefined } : null;
}

/** wasmer.io's sign-up page, which returns to the same authorization once the account exists. */
export function signupUrl(authUrl: string): string {
  const url = new URL(authUrl);
  return `${url.origin}/signup?${new URLSearchParams({ redirect: `${url.pathname}${url.search}` })}`;
}

// Anybuild: Wasmer's autobuild, the same deploy path as "Upload files" on wasmer.io/apps/create.
// Upload a zip to a signed URL, let Wasmer detect the stack, deploy it, then follow the build.

/** A one-time URL to PUT a zip to. The same URL (with its query) is what autobuild reads the source from. */
export async function signedUploadUrl(token: string, filename: string): Promise<string> {
  const data = await graphql<{ getSignedUrl: { url: string } | null }>(
    `query SignedUrl($filename: String!) { getSignedUrl(filename: $filename, method: "R2") { url } }`,
    { filename },
    token,
  );
  if (!data.getSignedUrl?.url) throw new WasmerError("Wasmer did not return an upload URL.");
  return data.getSignedUrl.url;
}

export async function uploadZip(url: string, zip: Uint8Array): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { method: "PUT", body: new Blob([zip as Uint8Array<ArrayBuffer>]), headers: { "Content-Type": "application/zip" }, signal: AbortSignal.timeout(120_000) });
  } catch {
    throw new WasmerError("Uploading the project to Wasmer failed. Check your connection and try again.");
  }
  if (!res.ok) throw new WasmerError(`Uploading the project to Wasmer failed (${res.status}).`);
}

export type BuildConfig = {
  appName: string;
  presetName: string;
  installCmd: string | null;
  buildCmd: string | null;
  startCmd: string | null;
  setupDb: boolean;
};

/** What Anybuild detected in the uploaded source: the framework preset and its commands. */
export async function autobuildConfig(token: string, uploadUrl: string): Promise<BuildConfig | null> {
  const data = await graphql<{ autobuildConfigForZipUpload: { buildConfig: BuildConfig | null } | null }>(
    `mutation AutobuildConfig($input: AutobuildConfigForZipUploadInput!) {
      autobuildConfigForZipUpload(input: $input) { buildConfig { appName presetName installCmd buildCmd startCmd setupDb } }
    }`,
    { input: { uploadUrl } },
    token,
  );
  return data.autobuildConfigForZipUpload?.buildConfig ?? null;
}

export type DeployInput = {
  uploadUrl: string;
  owner: string;
  appName: string;
  appId?: string;
  presetName?: string;
  installCmd?: string | null;
  buildCmd?: string | null;
  startCmd?: string | null;
  enableDatabase: boolean;
  dbEngine?: "POSTGRES";
  envVars?: { name: string; value: string }[];
};

/** Start an Anybuild deploy. Redeploys go to the same app (`allowExistingApp`). Returns the build id. */
export async function deployViaAutobuild(token: string, input: DeployInput): Promise<string> {
  const data = await graphql<{ deployViaAutobuild: { success: boolean; buildId: string } | null }>(
    `mutation Deploy($input: DeployViaAutobuildInput!) { deployViaAutobuild(input: $input) { success buildId } }`,
    { input: { ...input, allowExistingApp: true, waitForScreenshotGeneration: false } },
    token,
  );
  if (!data.deployViaAutobuild?.buildId) throw new WasmerError("Wasmer did not start the build.");
  return data.deployViaAutobuild.buildId;
}

export type BuildStatus = "QUEUED" | "WORKING" | "RUNNING" | "SUCCESS" | "FAILED" | "CANCELLED" | "INTERNAL_ERROR" | "TIMEOUT";
export const BUILD_DONE: readonly BuildStatus[] = ["SUCCESS", "FAILED", "CANCELLED", "INTERNAL_ERROR", "TIMEOUT"];

export type DeployedVersion = { id: string; version: string; url: string; app: { id: string; name: string; url: string; adminUrl: string } };

const VERSION_FIELDS = `appVersion { id version url app { id name url adminUrl } }`;

export async function buildStatus(token: string, buildId: string): Promise<{ status: BuildStatus; version: DeployedVersion | null } | null> {
  const data = await graphql<{ autobuildDeploymentStatus: { status: BuildStatus; appVersion: DeployedVersion | null } | null }>(
    `query BuildStatus($buildId: UUID!) { autobuildDeploymentStatus(buildId: $buildId) { status ${VERSION_FIELDS} } }`,
    { buildId },
    token,
  );
  const s = data.autobuildDeploymentStatus;
  return s ? { status: s.status, version: s.appVersion } : null;
}

export type BuildEvent = {
  kind: "PREPARING_TO_DEPLOY_STATUS" | "FETCHING_PLAN_STATUS" | "BUILD_STATUS" | "DEPLOY_STATUS" | "LOG" | "COMPLETE" | "FAILED";
  message: string | null;
  version: DeployedVersion | null;
};

/**
 * Live build events over the `graphql-transport-ws` protocol (what wasmer.io's own deploy screen subscribes to).
 * Best effort: callers still poll `buildStatus`, so a dropped socket only loses log lines. Returns a closer.
 */
export function watchBuild(token: string, buildId: string, onEvent: (event: BuildEvent) => void): () => void {
  let ws: WebSocket;
  try {
    ws = new WebSocket(registryUrl().replace(/^http/, "ws"), "graphql-transport-ws");
  } catch {
    return () => {};
  }
  ws.onopen = () => ws.send(JSON.stringify({ type: "connection_init", payload: { Authorization: `Bearer ${token}` } }));
  ws.onmessage = (e) => {
    let msg: { type?: string; payload?: { data?: { autobuildDeployment?: { kind: BuildEvent["kind"]; message: string | null; appVersion: DeployedVersion | null } | null } } };
    try {
      msg = JSON.parse(String(e.data));
    } catch {
      return;
    }
    if (msg.type === "connection_ack") {
      ws.send(
        JSON.stringify({
          id: "build",
          type: "subscribe",
          payload: { query: `subscription Build($buildId: UUID!) { autobuildDeployment(buildId: $buildId) { kind message ${VERSION_FIELDS} } }`, variables: { buildId } },
        }),
      );
    } else if (msg.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
    else if (msg.type === "next") {
      const ev = msg.payload?.data?.autobuildDeployment;
      if (ev) onEvent({ kind: ev.kind, message: ev.message, version: ev.appVersion });
    } else if (msg.type === "complete" || msg.type === "error") ws.close();
  };
  ws.onerror = () => {};
  return () => {
    if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close();
  };
}
