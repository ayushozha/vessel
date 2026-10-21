// Durable project memory through Provena (github.com/ayushozha/provena), so a follow-up never starts cold.
// Each workspace gets its own Provena brain (.provena/, an append-only ledger plus a repo map); preferences that
// apply to every project live in a user-level brain. Memory is best-effort: if the Provena CLI is not installed
// or a call fails, generation carries on without it. Server-only.
import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import type { MemoryKind } from "./generator/parse";
import { vesselHome } from "./projects";
import { workspaceDir } from "./workspace";

const run = promisify(execFile);
const CALL_TIMEOUT_MS = 60_000;
const CONTEXT_CHARS = 4000;

export type Memory = {
  id: string;
  kind: string;
  title: string;
  body: string;
  authority: "human" | "agent";
  scope: "project" | "user";
  createdAt: string;
};
export type NewMemory = { kind: MemoryKind; title: string; body: string; authority: "human" | "agent"; scope: "project" | "user"; sources?: string[] };

export const provenaCli = () =>
  process.env.VESSEL_PROVENA_CLI || path.join(vesselHome(), "toolchains", "provena", "cli", "dist", "cli.js");
export const memoryAvailable = () => existsSync(/*turbopackIgnore: true*/ provenaCli());
const userBrainDir = () => path.join(vesselHome(), "brain");

// Only what git and Node need: Provena never sees provider keys or other secrets from Adorable's environment.
function cliEnv(): NodeJS.ProcessEnv {
  const keep = ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"];
  return Object.fromEntries(keep.filter((k) => process.env[k]).map((k) => [k, process.env[k]])) as NodeJS.ProcessEnv;
}

// One Provena call at a time per brain: the ledger and the git index are not safe to write concurrently.
const queues = new Map<string, Promise<unknown>>();
function serial<T>(dir: string, job: () => Promise<T>): Promise<T> {
  const next = (queues.get(dir) ?? Promise.resolve()).then(job, job);
  queues.set(dir, next.catch(() => undefined));
  return next;
}

const provena = (dir: string, args: string[]) =>
  run(process.execPath, [provenaCli(), ...args], { cwd: dir, env: cliEnv(), timeout: CALL_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 << 20 });

/** Make `dir` a Provena brain once. Its git repo runs no hooks, so the user's global hooks never fire inside projects. */
async function ensureBrain(dir: string): Promise<void> {
  if (existsSync(/*turbopackIgnore: true*/ path.join(dir, ".provena", "manifest.json"))) return;
  await fs.mkdir(dir, { recursive: true });
  const noHooks = path.join(vesselHome(), "toolchains", "no-hooks");
  await fs.mkdir(noHooks, { recursive: true });
  if (!existsSync(/*turbopackIgnore: true*/ path.join(dir, ".git"))) {
    await run("git", ["init", "-q"], { cwd: dir, env: cliEnv(), windowsHide: true });
  }
  await run("git", ["config", "core.hooksPath", noHooks], { cwd: dir, env: cliEnv(), windowsHide: true });
  await provena(dir, ["init", "--no-daemon", "--no-hooks", "--no-agents", "--no-mcp", "--no-runtime"]);
}

async function writeMemory(dir: string, m: NewMemory): Promise<void> {
  await ensureBrain(dir);
  // Model-written text never reaches the CLI as something it could parse as a flag: the title loses leading dashes
  // and the body goes through stdin.
  const title = m.title.replace(/^[\s-]+/, "") || "Untitled";
  const args = ["remember", m.kind, title, "--stdin", "--authority", m.authority];
  for (const source of m.sources ?? []) if (!source.startsWith("-")) args.push("--source", source);
  const call = provena(dir, args);
  call.child.stdin?.end(m.body);
  await call;
}

/** Save memories into the project's (or the user's) brain, then refresh the project's repo map. Never throws. */
export async function remember(projectId: string, memories: NewMemory[], { refresh = true } = {}): Promise<void> {
  if (!memoryAvailable()) return;
  const project = workspaceDir(projectId);
  try {
    for (const m of memories.filter((x) => x.scope === "user")) await serial(userBrainDir(), () => writeMemory(userBrainDir(), m));
    await serial(project, async () => {
      await ensureBrain(project);
      for (const m of memories.filter((x) => x.scope === "project")) await writeMemory(project, m);
      if (refresh) await provena(project, ["refresh"]);
    });
  } catch (e) {
    console.warn(`[vessel] memory: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  }
}

/** Explicit memories in one brain's ledger, newest first. Repo facts Provena derives on its own are left out. */
async function readLedger(dir: string, scope: Memory["scope"]): Promise<Memory[]> {
  let raw: string;
  try {
    raw = await fs.readFile(/*turbopackIgnore: true*/ path.join(dir, ".provena", "memory", "events.jsonl"), "utf8");
  } catch {
    return [];
  }
  const byId = new Map<string, Memory>();
  const inactive = new Set<string>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (!e.id || !e.title || (e.tags ?? []).some((t: string) => t.startsWith("provena:managed"))) continue;
      byId.set(e.id, {
        id: e.id,
        kind: e.kind,
        title: e.title,
        body: e.body ?? "",
        authority: e.authority === "human" ? "human" : "agent",
        scope,
        createdAt: e.created_at ?? "",
      });
      if ((e.status ?? "active") === "active") inactive.delete(e.id);
      else inactive.add(e.id);
    } catch {
      // A torn last line from a concurrent write; skip it.
    }
  }
  return [...byId.values()]
    .filter((m) => !inactive.has(m.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function listMemories(projectId: string): Promise<Memory[]> {
  const [project, user] = await Promise.all([readLedger(workspaceDir(projectId), "project"), readLedger(userBrainDir(), "user")]);
  return [...project, ...user];
}

/** Memories as a prompt section: human-authored first, then newest, within a fixed budget. Empty when there are none. */
export async function memoryContext(projectId: string): Promise<string> {
  const all = (await listMemories(projectId)).sort((a, b) => Number(b.authority === "human") - Number(a.authority === "human"));
  const lines: string[] = [];
  let used = 0;
  for (const m of all) {
    const line = `- [${m.kind}${m.scope === "user" ? ", all projects" : ""}${m.authority === "human" ? ", set by the user" : ""}] ${m.title}: ${m.body.replace(/\s+/g, " ")}`;
    if (used + line.length > CONTEXT_CHARS) break;
    lines.push(line);
    used += line.length;
  }
  return lines.join("\n");
}
