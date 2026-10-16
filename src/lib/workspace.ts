// A project's generated source files. Server-only.
// Every path comes from model output, so it is validated before it can touch the filesystem.
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { isProjectId, vesselHome } from "./projects";

export const LIMITS = { fileBytes: 512 * 1024, files: 300, pathLength: 200, depth: 12, snapshotBytes: 120 * 1024 };

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

function resolve(projectId: string, rel: string): string {
  const checked = validatePath(rel);
  if (!checked.ok) throw new Error(checked.reason);
  const root = workspaceDir(projectId);
  const full = path.join(root, ...checked.path.split("/"));
  // Defense in depth: the joined path must still be inside the workspace.
  if (path.relative(root, full).startsWith("..")) throw new Error("path escapes the workspace");
  return full;
}

export type FileEntry = { path: string; bytes: number };

export async function listFiles(projectId: string): Promise<FileEntry[]> {
  const root = workspaceDir(projectId);
  const out: FileEntry[] = [];
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
      if (entry.isDirectory()) await walk(full, rel);
      else if (entry.isFile()) out.push({ path: rel, bytes: (await fs.stat(/*turbopackIgnore: true*/ full)).size });
    }
  }
  await walk(root, "");
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export async function readFile(projectId: string, rel: string): Promise<string | null> {
  try {
    const full = resolve(projectId, rel);
    const stat = await fs.stat(/*turbopackIgnore: true*/ full);
    if (stat.size > LIMITS.fileBytes) return null;
    return await fs.readFile(/*turbopackIgnore: true*/ full, "utf8");
  } catch {
    return null;
  }
}

export async function writeFile(projectId: string, rel: string, content: string): Promise<FileEntry> {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > LIMITS.fileBytes) throw new Error(`file is larger than ${LIMITS.fileBytes / 1024} KB`);
  const checked = validatePath(rel);
  if (!checked.ok) throw new Error(checked.reason);
  const full = resolve(projectId, checked.path);
  const exists = await fs.stat(/*turbopackIgnore: true*/ full).then(() => true, () => false);
  if (!exists && (await listFiles(projectId)).length >= LIMITS.files) throw new Error(`workspace is limited to ${LIMITS.files} files`);
  await fs.mkdir(/*turbopackIgnore: true*/ path.dirname(full), { recursive: true });
  const tmp = `${full}.${randomUUID()}.tmp`;
  await fs.writeFile(/*turbopackIgnore: true*/ tmp, content);
  await fs.rename(/*turbopackIgnore: true*/ tmp, full);
  return { path: checked.path, bytes };
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
    const content = f.bytes <= 64 * 1024 && used + f.bytes <= budget ? await readFile(projectId, f.path) : null;
    if (content === null) {
      parts.push(`<file path="${f.path}" omitted="${f.bytes} bytes" />`);
      continue;
    }
    used += f.bytes;
    parts.push(`<file path="${f.path}">\n${content}\n</file>`);
  }
  return parts.join("\n\n");
}
