// Workspace change notifications. Server-only.
// Every write to a project's workspace emits a change; the sandbox runtime subscribes and syncs the files.
import { EventEmitter } from "node:events";

export type WorkspaceChangeSource = "generator" | "upload" | "edit" | "zip" | "delete" | "rename";

/** `paths` are workspace-relative paths that were written, created or removed. Consumers re-read each path to see its current state. */
export type WorkspaceChange = { projectId: string; paths: string[]; source: WorkspaceChangeSource };

// One emitter per server process, shared across route modules and hot reloads.
const g = globalThis as typeof globalThis & { __vesselWorkspaceEvents?: EventEmitter };
const emitter = (g.__vesselWorkspaceEvents ??= new EventEmitter().setMaxListeners(50));

export function emitWorkspaceChanged(change: WorkspaceChange): void {
  if (change.paths.length) emitter.emit("change", change);
}

export function onWorkspaceChanged(listener: (change: WorkspaceChange) => void): () => void {
  emitter.on("change", listener);
  return () => emitter.off("change", listener);
}
