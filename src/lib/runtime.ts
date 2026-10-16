// Connects projects to their live sandbox: picks the stack, starts it, and keeps it in sync with the workspace.
// Server-only.
import { promises as fs } from "node:fs";
import path from "node:path";

import { isProjectId } from "./projects";
import { sandboxPool, type LogEntry, type ProjectSandbox, type SandboxState, type StackId } from "./sandbox";
import { validatePath, workspaceDir } from "./workspace";
import { onWorkspaceChanged, type WorkspaceChange } from "./workspace-events";

export type RuntimeStatus = {
  state: SandboxState | "idle";
  appUrl: string | null;
  stack: StackId | null;
  database: boolean;
  error: string | null;
};

const SYNC_DEBOUNCE_MS = 400;
const errors = new Map<string, string>();

/** Projects whose package.json depends on `pg` get a persistent local Postgres; everything else runs plain Node. */
export async function stackFor(projectId: string): Promise<StackId | null> {
  const root = workspaceDir(projectId);
  const hasServer = await fs.stat(/*turbopackIgnore: true*/ path.join(root, "server.js")).then(() => true, () => false);
  if (!hasServer) return null;
  try {
    const manifest = JSON.parse(await fs.readFile(/*turbopackIgnore: true*/ path.join(root, "package.json"), "utf8"));
    const deps = { ...manifest.dependencies, ...manifest.devDependencies };
    return "pg" in deps ? "node-pglite" : "node";
  } catch {
    return "node";
  }
}

export function status(projectId: string): RuntimeStatus {
  const sb = sandboxPool().get(projectId);
  const error = sb?.error ?? errors.get(projectId) ?? null;
  if (!sb) return { state: "idle", appUrl: null, stack: null, database: false, error };
  return { state: sb.state, appUrl: sb.state === "running" ? sb.appUrl : null, stack: sb.stack, database: sb.stack === "node-pglite", error };
}

/** Start the project's sandbox if it can run (it has a server.js) and is not already running. */
export async function ensureRunning(projectId: string): Promise<RuntimeStatus> {
  if (!isProjectId(projectId)) throw new Error("invalid project id");
  const stack = await stackFor(projectId);
  if (!stack) {
    errors.set(projectId, "Nothing to run yet: the project has no server.js.");
    return status(projectId);
  }
  errors.delete(projectId);
  try {
    await sandboxPool().start(projectId, stack);
  } catch (e) {
    errors.set(projectId, (e as Error).message);
  }
  return status(projectId);
}

export async function restart(projectId: string): Promise<RuntimeStatus> {
  const sb = sandboxPool().get(projectId);
  if (!sb || sb.state === "stopped") return ensureRunning(projectId);
  await sb.restart().catch((e: Error) => errors.set(projectId, e.message));
  return status(projectId);
}

export async function resetData(projectId: string): Promise<RuntimeStatus> {
  await sandboxPool().resetData(projectId).catch((e: Error) => errors.set(projectId, e.message));
  return status(projectId);
}

export async function stop(projectId: string): Promise<RuntimeStatus> {
  await sandboxPool().stop(projectId, { withDatabase: true });
  return status(projectId);
}

export function sandboxFor(projectId: string): ProjectSandbox | undefined {
  return sandboxPool().get(projectId);
}
export type { LogEntry };

/** Read changed paths from the workspace as bytes; null means the file is gone. */
async function readChanges(projectId: string, paths: string[]): Promise<Record<string, Buffer | null>> {
  const root = workspaceDir(projectId);
  const out: Record<string, Buffer | null> = {};
  for (const p of paths) {
    const checked = validatePath(p);
    if (!checked.ok) continue;
    out[checked.path] = await fs.readFile(/*turbopackIgnore: true*/ path.join(root, ...checked.path.split("/"))).catch(() => null);
  }
  return out;
}

/** Apply one batch of workspace changes to a running sandbox, or start it when the project became runnable. */
export async function applyChanges(projectId: string, paths: string[]): Promise<void> {
  const sb = sandboxPool().get(projectId);
  if (!sb || sb.state === "stopped") {
    await ensureRunning(projectId);
    return;
  }
  // A new dependency set (or a different stack) needs a fresh boot with an install.
  if (paths.includes("package.json")) {
    await sandboxPool().stop(projectId);
    await ensureRunning(projectId);
    return;
  }
  await sb.syncFiles(await readChanges(projectId, paths));
  // Files under public/ are static assets read on each request; anything else may be server code, so restart.
  if (paths.some((p) => !p.startsWith("public/"))) await sb.restart();
}

// One subscription per server process: workspace writes from the generator, uploads and edits flow into sandboxes.
const g = globalThis as typeof globalThis & { __vesselRuntimeSync?: () => void };
export function initRuntimeSync(): void {
  if (g.__vesselRuntimeSync) return;
  const pending = new Map<string, { paths: Set<string>; timer: ReturnType<typeof setTimeout> }>();
  g.__vesselRuntimeSync = onWorkspaceChanged((change: WorkspaceChange) => {
    const entry = pending.get(change.projectId) ?? { paths: new Set<string>(), timer: undefined as unknown as ReturnType<typeof setTimeout> };
    change.paths.forEach((p) => entry.paths.add(p));
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      pending.delete(change.projectId);
      applyChanges(change.projectId, [...entry.paths]).catch((e: Error) => errors.set(change.projectId, e.message));
    }, SYNC_DEBOUNCE_MS);
    pending.set(change.projectId, entry);
  });
}
