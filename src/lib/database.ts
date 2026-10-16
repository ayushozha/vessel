// Persistent local PostgreSQL per project. Server-only.
// Each project gets PGlite in its own host process with an on-disk data directory, on a random 127.0.0.1 port.
// Works offline; data survives app restarts, server restarts and code changes until "Reset data".
import { fork, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import { isProjectId, vesselHome } from "./projects";

export interface DatabaseProvider {
  /** Start (or return) the project's database and resolve with its port. */
  start(projectId: string): Promise<number>;
  /** Stop the database and delete its data, so the next start is empty. */
  reset(projectId: string): Promise<void>;
  stop(projectId: string): Promise<void>;
}

export const dataDir = (projectId: string) => {
  if (!isProjectId(projectId)) throw new Error("invalid project id");
  return path.join(vesselHome(), "projects", projectId, "pgdata");
};

type Reply = { id: number; ok: boolean; error?: string; port?: number };
export type ForkDbHost = () => ChildProcess;

export const forkDbHost: ForkDbHost = () => {
  const hostScript = path.join(process.cwd(), "src", "lib", "db-host.mjs");
  return fork(/*turbopackIgnore: true*/ hostScript, [], {
    // No --permission here: PGlite needs process.binding, which the permission model blocks outright. This host
    // only runs Vessel's own code (generated code never executes here; apps send SQL over TCP), in its own
    // process with a scrubbed environment. See docs/runtime-findings.md, "Security model".
    env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", TEMP: process.env.TEMP ?? "", TMP: process.env.TMP ?? "" } as unknown as NodeJS.ProcessEnv,
    cwd: process.cwd(),
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
};

function call(child: ChildProcess, op: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const timer = setTimeout(() => reject(new Error(`database ${op} timed out`)), timeoutMs);
    const onMessage = (m: Reply) => {
      if (m.id !== id) return;
      cleanup();
      if (m.ok) resolve(m);
      else reject(new Error(m.error ?? `database ${op} failed`));
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`database host exited (${code})`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.on("exit", onExit);
    child.send({ id, op, ...args });
  });
}

export class DatabasePool implements DatabaseProvider {
  #running = new Map<string, { child: ChildProcess; port: number }>();
  #starting = new Map<string, Promise<number>>();

  constructor(private readonly forkFn: ForkDbHost = forkDbHost) {}

  start(projectId: string): Promise<number> {
    const running = this.#running.get(projectId);
    if (running) return Promise.resolve(running.port);
    const inFlight = this.#starting.get(projectId);
    if (inFlight) return inFlight;
    const started = this.#start(projectId).finally(() => this.#starting.delete(projectId));
    this.#starting.set(projectId, started);
    return started;
  }

  async #start(projectId: string): Promise<number> {
    const dir = dataDir(projectId);
    await fs.mkdir(/*turbopackIgnore: true*/ dir, { recursive: true });
    const child = this.forkFn();
    child.on("exit", () => {
      if (this.#running.get(projectId)?.child === child) this.#running.delete(projectId);
    });
    try {
      const { port } = await call(child, "start", { dataDir: dir });
      this.#running.set(projectId, { child, port: port! });
      return port!;
    } catch (e) {
      child.kill();
      throw e;
    }
  }

  async stop(projectId: string): Promise<void> {
    const running = this.#running.get(projectId);
    if (!running) return;
    this.#running.delete(projectId);
    await call(running.child, "stop", {}, 10_000).catch(() => undefined);
    running.child.kill();
  }

  async reset(projectId: string): Promise<void> {
    await this.stop(projectId);
    await fs.rm(/*turbopackIgnore: true*/ dataDir(projectId), { recursive: true, force: true });
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.#running.keys()].map((id) => this.stop(id)));
  }
}

const g = globalThis as typeof globalThis & { __vesselDatabasePool?: DatabasePool };
/** The server's database pool, kept across dev hot reloads. */
export const databasePool = (): DatabasePool => (g.__vesselDatabasePool ??= new DatabasePool());
