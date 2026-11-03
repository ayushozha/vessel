// One-click publish to Wasmer Edge through Anybuild (Wasmer's autobuild). Server-only.
//
// 1. Zip the project's workspace (it never holds secrets, node_modules or Adorable's own folders; see workspace.ts).
// 2. Upload the zip to a signed Wasmer URL and let Anybuild detect the stack and its commands.
// 3. Deploy under the linked Wasmer account. Apps that use Postgres get a managed Postgres database: Edge injects
//    the same DB_* variables the local sandbox sets, so the generated code runs unchanged. Edge defaults to MySQL,
//    so the engine is always named.
// 4. Follow the build (live events for logs, polling for the outcome) and remember the app, so the next publish
//    deploys a new version of the same app.
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { zipSync } from "fflate";
import { z } from "zod";

import { readStore } from "./credentials";
import { getProject, isProjectId, vesselHome, type Project } from "./projects";
import { stackFor } from "./runtime";
import { STACKS } from "./sandbox";
import {
  autobuildConfig,
  BUILD_DONE,
  buildStatus,
  deployViaAutobuild,
  signedUploadUrl,
  uploadZip,
  watchBuild,
  WasmerError,
  type BuildStatus,
  type DeployedVersion,
} from "./wasmer";
import { listFiles, readBytes } from "./workspace";

export type DeployStep = "packing" | "uploading" | "detecting" | "building" | "deploying" | "live" | "failed";
export type DeployJob = {
  step: DeployStep;
  startedAt: string;
  finishedAt?: string;
  buildId?: string;
  preset?: string;
  url?: string;
  error?: string;
  /** The step a failed publish stopped at. */
  failedAt?: DeployStep;
  logs: string[];
};

const Deployment = z.object({
  owner: z.string(),
  appName: z.string(),
  appId: z.string().optional(),
  url: z.string().optional(),
  adminUrl: z.string().optional(),
  version: z.string().optional(),
  preset: z.string().optional(),
  publishedAt: z.string().optional(),
});
export type Deployment = z.infer<typeof Deployment>;

export type DeployStatus = { job: DeployJob | null; deployment: Deployment | null };

export class DeployError extends Error {
  code: "unlinked" | "busy" | "empty";
  constructor(message: string, code: DeployError["code"]) {
    super(message);
    this.code = code;
  }
}

const POLL_MS = 3_000;
const BUILD_TIMEOUT_MS = 20 * 60_000;
const MAX_LOG_LINES = 500;

const g = globalThis as typeof globalThis & { __vesselDeploys?: Map<string, DeployJob> };
const jobs = (g.__vesselDeploys ??= new Map());

const deploymentFile = (projectId: string) => {
  if (!isProjectId(projectId)) throw new Error("invalid project id");
  return path.join(vesselHome(), "projects", projectId, "deployment.json");
};

export async function readDeployment(projectId: string): Promise<Deployment | null> {
  try {
    return Deployment.parse(JSON.parse(await fs.readFile(/*turbopackIgnore: true*/ deploymentFile(projectId), "utf8")));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

async function saveDeployment(projectId: string, deployment: Deployment): Promise<void> {
  const file = deploymentFile(projectId);
  await fs.mkdir(/*turbopackIgnore: true*/ path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(/*turbopackIgnore: true*/ tmp, JSON.stringify(Deployment.parse(deployment), null, 2), { mode: 0o600 });
  await fs.rename(/*turbopackIgnore: true*/ tmp, file);
}

/** A stable Wasmer app name: the project name as a slug plus a piece of its id, so two projects never collide. */
export function appNameFor(project: Pick<Project, "id" | "name">): string {
  const slug = project.name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  const name = `${slug || "app"}-${project.id.slice(0, 6)}`;
  return /^[a-z]/.test(name) ? name : `app-${name}`;
}

/** The workspace as a zip archive, paths relative to its root. */
export async function zipWorkspace(projectId: string): Promise<Uint8Array> {
  const files = await listFiles(projectId);
  const entries: Record<string, Uint8Array> = {};
  for (const f of files) {
    const bytes = await readBytes(projectId, f.path);
    if (bytes) entries[f.path] = new Uint8Array(bytes);
  }
  if (Object.keys(entries).length === 0) throw new DeployError("Nothing to publish yet. Build something first.", "empty");
  return zipSync(entries, { level: 6 });
}

export async function deployStatus(projectId: string): Promise<DeployStatus> {
  return { job: jobs.get(projectId) ?? null, deployment: await readDeployment(projectId) };
}

/** Start publishing. The work continues in the background; poll `deployStatus` for progress. */
export async function startDeploy(projectId: string): Promise<DeployStatus> {
  const project = await getProject(projectId);
  if (!project) throw new Error("project not found");
  const running = jobs.get(projectId);
  if (running && running.step !== "live" && running.step !== "failed") throw new DeployError("A publish is already in progress.", "busy");
  const { wasmer } = await readStore();
  if (!wasmer) throw new DeployError("Sign in with Wasmer to publish.", "unlinked");

  const zip = await zipWorkspace(projectId);
  const job: DeployJob = { step: "packing", startedAt: new Date().toISOString(), logs: [] };
  jobs.set(projectId, job);
  log(job, `Packed ${Math.max(1, Math.round(zip.byteLength / 1024))} KB of source`);
  void run(project, wasmer.token, wasmer.username, zip, job).catch((e) => {
    const message = e instanceof WasmerError || e instanceof DeployError ? e.message : "Publishing failed unexpectedly.";
    if (!(e instanceof WasmerError || e instanceof DeployError)) console.error(e);
    fail(job, message);
  });
  return deployStatus(projectId);
}

async function run(project: Project, token: string, username: string, zip: Uint8Array, job: DeployJob): Promise<void> {
  const previous = await readDeployment(project.id);
  const owner = previous?.owner ?? username;
  const appName = previous?.appName ?? appNameFor(project);

  job.step = "uploading";
  const uploadUrl = await signedUploadUrl(token, `${appName}-${Date.now().toString(36)}.zip`);
  await uploadZip(uploadUrl, zip);
  log(job, "Uploaded to Wasmer");

  job.step = "detecting";
  const config = await autobuildConfig(token, uploadUrl).catch((e) => {
    // Detection is a convenience: without it Anybuild still detects the stack during the build.
    log(job, `Stack detection skipped: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  });
  const stack = await stackFor(project.id);
  const enableDatabase = stack ? STACKS[stack].db : (config?.setupDb ?? false);
  job.preset = config?.presetName;
  log(job, `Detected ${config?.presetName ?? "stack during build"}${enableDatabase ? " · managed Postgres" : ""}`);

  await saveDeployment(project.id, { ...previous, owner, appName });
  const buildId = await deployViaAutobuild(token, {
    uploadUrl,
    owner,
    appName,
    appId: previous?.appId,
    presetName: config?.presetName,
    installCmd: config?.installCmd,
    buildCmd: config?.buildCmd,
    startCmd: config?.startCmd,
    enableDatabase,
    dbEngine: enableDatabase ? "POSTGRES" : undefined,
    envVars: [{ name: "NODE_ENV", value: "production" }],
  });
  job.buildId = buildId;
  job.step = "building";
  log(job, `Build ${buildId} started on Wasmer`);

  const stopWatching = watchBuild(token, buildId, (event) => {
    if (event.kind === "DEPLOY_STATUS" && job.step === "building") job.step = "deploying";
    if (event.kind === "LOG" && event.message) for (const line of event.message.split("\n")) if (line.trim()) log(job, line);
    if (event.kind === "FAILED" && event.message) log(job, event.message);
  });
  try {
    const outcome = await waitForBuild(token, buildId);
    if (outcome.status !== "SUCCESS" || !outcome.version) {
      fail(job, `The Wasmer build ended with ${outcome.status.toLowerCase().replace("_", " ")}. See the build log for why.`);
      return;
    }
    await finishLive(project.id, job, { ...previous, owner, appName }, outcome.version);
  } finally {
    stopWatching();
  }
}

async function waitForBuild(token: string, buildId: string): Promise<{ status: BuildStatus; version: DeployedVersion | null }> {
  const deadline = Date.now() + BUILD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    // A failed poll (network blip) is retried until the deadline.
    const current = await buildStatus(token, buildId).catch(() => null);
    if (current && BUILD_DONE.includes(current.status)) return current;
  }
  return { status: "TIMEOUT", version: null };
}

async function finishLive(projectId: string, job: DeployJob, base: Deployment, version: DeployedVersion): Promise<void> {
  const url = version.app.url || version.url;
  await saveDeployment(projectId, {
    ...base,
    appName: version.app.name || base.appName,
    appId: version.app.id,
    url,
    adminUrl: version.app.adminUrl,
    version: version.version,
    preset: job.preset ?? base.preset,
    publishedAt: new Date().toISOString(),
  });
  job.url = url;
  job.step = "live";
  job.finishedAt = new Date().toISOString();
  log(job, `Live at ${url}`);
}

function fail(job: DeployJob, error: string) {
  if (job.step === "live" || job.step === "failed") return;
  job.failedAt = job.step;
  job.step = "failed";
  job.error = error;
  job.finishedAt = new Date().toISOString();
  log(job, error);
}

function log(job: DeployJob, line: string) {
  job.logs.push(line);
  if (job.logs.length > MAX_LOG_LINES) job.logs.splice(0, job.logs.length - MAX_LOG_LINES);
}
