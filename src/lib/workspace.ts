// A project's generated source files. Server-only.
// Every path comes from model output or user uploads, so it is validated before it can touch the filesystem.
import { isUtf8 } from "node:buffer";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { isProjectId, vesselHome } from "./projects";

export const LIMITS = { fileBytes: 512 * 1024, files: 300, dirs: 300, totalBytes: 25 * 1024 * 1024, pathLength: 200, depth: 12, snapshotBytes: 120 * 1024 };

/** A refused workspace operation. `code` decides the HTTP status in the file routes. */
export class WorkspaceError extends Error {
  code: "invalid" | "conflict" | "missing" | "limit";
  constructor(message: string, code: WorkspaceError["code"] = "invalid") {
    super(message);
    this.code = code;
  }
}

const BINARY_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|wasm|mp3|mp4|webm|ogg|wav|mov)$/i;

/** Binary by extension, or by content that is not plain UTF-8 text. */
export function isBinary(rel: string, data?: Uint8Array): boolean {
  return BINARY_EXT.test(rel) || (!!data && (data.subarray(0, 8000).includes(0) || !isUtf8(data)));
}

const SEGMENT = /^[A-Za-z0-9_@()+\-][A-Za-z0-9._@()+\- ]*$/;
const BLOCKED_SEGMENTS = new Set(["node_modules", ".git", ".wasmer", ".next", "dist-ssr"]);
// Generated code must never carry real secrets; .env.example documents variables instead.
const BLOCKED_FILES = /^\.env(\..*)?$/;

/** Normalized workspace-relative path, or a reason it is not allowed. */
export function validatePath(raw: string): { ok: true; path: string } | { ok: false; reason: string } {
  const p = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!p) return { ok: false, reason: "empty path" };
  if (p.length > LIMITS.pathLength) return { ok: false, reason: "path too long" };
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return { ok: false, reason: "absolute path" };
  const parts = p.split("/");
  if (parts.length > LIMITS.depth) return { ok: false, reason: "path too deep" };
  for (const part of parts) {
    if (part === "." || part === "..") return { ok: false, reason: "path escapes the workspace" };
    if (BLOCKED_SEGMENTS.has(part)) return { ok: false, reason: `${part} is managed by Vessel` };
    const allowedDotfile = /^\.(gitignore|env\.example|npmrc|nvmrc|prettierrc)$/.test(part);
    if (!allowedDotfile && !SEGMENT.test(part)) return { ok: false, reason: "unsupported characters in path" };
  }
  const name = parts[parts.length - 1];
  if (BLOCKED_FILES.test(name) && name !== ".env.example") return { ok: false, reason: "secrets files are not generated; use .env.example" };
  return { ok: true, path: parts.join("/") };
}

export function workspaceDir(projectId: string): string {
  if (!isProjectId(projectId)) throw new Error("invalid project id");
  return path.join(vesselHome(), "projects", projectId, "workspace");
}

function mustValidate(rel: string): string {
  const checked = validatePath(rel);
  if (!checked.ok) throw new WorkspaceError(`${rel}: ${checked.reason}`);
  return checked.path;
}

function resolve(projectId: string, rel: string): string {
  const checked = validatePath(rel);
  if (!checked.ok) throw new WorkspaceError(checked.reason);
  const root = workspaceDir(projectId);
  const full = path.join(root, ...checked.path.split("/"));
  // Defense in depth: the joined path must still be inside the workspace.
  if (path.relative(root, full).startsWith("..")) throw new Error("path escapes the workspace");
  return full;
}

export type FileEntry = { path: string; bytes: number };
export type TreeEntry = FileEntry & { type: "file" | "dir" };

/** Every file and folder (empty folders included), sorted by path. */
export async function listEntries(projectId: string): Promise<TreeEntry[]> {
  const root = workspaceDir(projectId);
  const out: TreeEntry[] = [];
  async function walk(dir: string, prefix: string) {
    let entries;
    try {
      entries = await fs.readdir(/*turbopackIgnore: true*/ dir, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    for (const entry of entries) {
      if (BLOCKED_SEGMENTS.has(entry.name) || entry.name.endsWith(".tmp")) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push({ path: rel, bytes: 0, type: "dir" });
        await walk(full, rel);
      } else if (entry.isFile()) out.push({ path: rel, bytes: (await fs.stat(/*turbopackIgnore: true*/ full)).size, type: "file" });
    }
  }
  await walk(root, "");
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export async function listFiles(projectId: string): Promise<FileEntry[]> {
  return (await listEntries(projectId)).filter((e) => e.type === "file").map(({ path, bytes }) => ({ path, bytes }));
}

// Lookups are case-insensitive: on Windows and macOS `README.md` and `readme.md` are the same file.
function index(entries: TreeEntry[]) {
  const map = new Map(entries.map((e) => [e.path.toLowerCase(), e]));
  return { map, kind: (p: string) => map.get(p.toLowerCase())?.type ?? null };
}

/** Entries at and under `p`. */
function subtree(entries: TreeEntry[], p: string): TreeEntry[] {
  const lower = p.toLowerCase();
  return entries.filter((e) => e.path.toLowerCase() === lower || e.path.toLowerCase().startsWith(`${lower}/`));
}

function ancestors(p: string): string[] {
  const parts = p.split("/");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
}

export async function readBytes(projectId: string, rel: string): Promise<Buffer | null> {
  try {
    const full = resolve(projectId, rel);
    const stat = await fs.stat(/*turbopackIgnore: true*/ full);
    if (!stat.isFile() || stat.size > LIMITS.fileBytes) return null;
    return await fs.readFile(/*turbopackIgnore: true*/ full);
  } catch {
    return null;
  }
}

export async function readFile(projectId: string, rel: string): Promise<string | null> {
  return (await readBytes(projectId, rel))?.toString("utf8") ?? null;
}

/** Existing files that writing `paths` would overwrite. */
export async function findConflicts(projectId: string, paths: string[]): Promise<string[]> {
  const { kind } = index(await listEntries(projectId));
  return paths.filter((p) => kind(p) === "file");
}

export type WriteInput = { path: string; data: string | Uint8Array };

/**
 * Writes several files after checking all of them against the paths and limits, so a refused batch writes nothing.
 * (An I/O error part-way through can still leave the earlier files written.)
 * Existing files are replaced unless `overwrite` is false.
 */
export async function writeFiles(projectId: string, inputs: WriteInput[], { overwrite = true } = {}): Promise<FileEntry[]> {
  const entries = await listEntries(projectId);
  const { map, kind } = index(entries);
  let files = entries.filter((e) => e.type === "file").length;
  let dirs = entries.length - files;
  let total = entries.reduce((sum, e) => sum + e.bytes, 0);
  const planned: { path: string; data: Buffer }[] = [];
  for (const input of inputs) {
    const p = mustValidate(input.path);
    const data = typeof input.data === "string" ? Buffer.from(input.data, "utf8") : Buffer.from(input.data.buffer, input.data.byteOffset, input.data.byteLength);
    if (data.length > LIMITS.fileBytes) throw new WorkspaceError(`${p} is larger than ${LIMITS.fileBytes / 1024} KB`, "limit");
    if (planned.some((f) => f.path.toLowerCase() === p.toLowerCase())) throw new WorkspaceError(`${p} appears twice`);
    if (kind(p) === "dir") throw new WorkspaceError(`${p} is a folder`, "conflict");
    for (const dir of ancestors(p)) {
      if (kind(dir) === "file") throw new WorkspaceError(`${dir} is a file, not a folder`, "conflict");
      if (!kind(dir)) {
        map.set(dir.toLowerCase(), { path: dir, bytes: 0, type: "dir" });
        dirs++;
      }
    }
    const old = map.get(p.toLowerCase());
    if (old && !overwrite) throw new WorkspaceError(`${p} already exists`, "conflict");
    if (!old) files++;
    total += data.length - (old?.bytes ?? 0);
    map.set(p.toLowerCase(), { path: p, bytes: data.length, type: "file" });
    planned.push({ path: p, data });
  }
  if (files > LIMITS.files) throw new WorkspaceError(`workspace is limited to ${LIMITS.files} files`, "limit");
  if (dirs > LIMITS.dirs) throw new WorkspaceError(`workspace is limited to ${LIMITS.dirs} folders`, "limit");
  if (total > LIMITS.totalBytes) throw new WorkspaceError(`workspace is limited to ${LIMITS.totalBytes / 1024 / 1024} MB`, "limit");
  for (const { path: p, data } of planned) {
    const full = resolve(projectId, p);
    await fs.mkdir(/*turbopackIgnore: true*/ path.dirname(full), { recursive: true });
    const tmp = `${full}.${randomUUID()}.tmp`;
    await fs.writeFile(/*turbopackIgnore: true*/ tmp, data);
    await fs.rename(/*turbopackIgnore: true*/ tmp, full);
  }
  return planned.map((f) => ({ path: f.path, bytes: f.data.length }));
}

export async function writeFile(projectId: string, rel: string, content: string | Uint8Array, opts?: { overwrite?: boolean }): Promise<FileEntry> {
  return (await writeFiles(projectId, [{ path: rel, data: content }], opts))[0];
}

/** Creates a folder (and missing parents). Returns the folders that were created. */
export async function createFolder(projectId: string, rel: string): Promise<string[]> {
  const p = mustValidate(rel);
  const entries = await listEntries(projectId);
  const { kind } = index(entries);
  if (kind(p)) throw new WorkspaceError(`${p} already exists`, "conflict");
  const parentFile = ancestors(p).find((d) => kind(d) === "file");
  if (parentFile) throw new WorkspaceError(`${parentFile} is a file, not a folder`, "conflict");
  const created = [...ancestors(p).filter((d) => !kind(d)), p];
  if (entries.filter((e) => e.type === "dir").length + created.length > LIMITS.dirs) throw new WorkspaceError(`workspace is limited to ${LIMITS.dirs} folders`, "limit");
  await fs.mkdir(/*turbopackIgnore: true*/ resolve(projectId, p), { recursive: true });
  return created;
}

/** Renames or moves a file or folder. Only a file may replace an existing file, and only with `overwrite`. Returns old and new paths. */
export async function renameEntry(projectId: string, from: string, to: string, { overwrite = false } = {}): Promise<string[]> {
  const a = mustValidate(from);
  const b = mustValidate(to);
  if (a === b) return [];
  const caseOnly = a.toLowerCase() === b.toLowerCase();
  if (!caseOnly && b.toLowerCase().startsWith(`${a.toLowerCase()}/`)) throw new WorkspaceError("A folder cannot be moved into itself.");
  const entries = await listEntries(projectId);
  const { kind } = index(entries);
  const source = kind(a);
  if (!source) throw new WorkspaceError(`${a} does not exist`, "missing");
  const target = caseOnly ? null : kind(b);
  if (target && !overwrite) throw new WorkspaceError(`${b} already exists`, "conflict");
  if (target && (target === "dir" || source === "dir")) throw new WorkspaceError(`${b} already exists; only a file can replace a file`, "conflict");
  const parentFile = ancestors(b).find((d) => kind(d) === "file");
  if (parentFile) throw new WorkspaceError(`${parentFile} is a file, not a folder`, "conflict");
  const moved = subtree(entries, a).map((e) => e.path);
  const dest = resolve(projectId, b);
  await fs.mkdir(/*turbopackIgnore: true*/ path.dirname(dest), { recursive: true });
  await fs.rename(/*turbopackIgnore: true*/ resolve(projectId, a), dest);
  return [...moved, ...moved.map((p) => b + p.slice(a.length))];
}

/** Deletes a file, or a folder with everything in it (up to the workspace file limit). Returns the removed paths. */
export async function deleteEntry(projectId: string, rel: string): Promise<string[]> {
  const p = mustValidate(rel);
  const entries = await listEntries(projectId);
  const kind = index(entries).kind(p);
  if (!kind) throw new WorkspaceError(`${p} does not exist`, "missing");
  const removed = subtree(entries, p).map((e) => e.path);
  if (removed.length > LIMITS.files) throw new WorkspaceError(`${p} holds more than ${LIMITS.files} entries; delete it in parts`, "limit");
  await fs.rm(/*turbopackIgnore: true*/ resolve(projectId, p), { recursive: kind === "dir" });
  return removed;
}

export async function deleteFile(projectId: string, rel: string): Promise<boolean> {
  try {
    await fs.rm(/*turbopackIgnore: true*/ resolve(projectId, rel));
    return true;
  } catch {
    return false;
  }
}

/** The current source as model context, within a byte budget; large files are listed but not inlined. */
export async function snapshot(projectId: string, budget = LIMITS.snapshotBytes): Promise<string> {
  const files = await listFiles(projectId);
  if (!files.length) return "";
  let used = 0;
  const parts: string[] = [];
  for (const f of files) {
    const data = f.bytes <= 64 * 1024 && used + f.bytes <= budget ? await readBytes(projectId, f.path) : null;
    const content = data && !isBinary(f.path, data) ? data.toString("utf8") : null;
    if (content === null) {
      parts.push(`<file path="${f.path}" omitted="${f.bytes} bytes" />`);
      continue;
    }
    used += f.bytes;
    parts.push(`<file path="${f.path}">\n${content}\n</file>`);
  }
  return parts.join("\n\n");
}
