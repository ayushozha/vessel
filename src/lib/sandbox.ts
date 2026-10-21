// Local sandbox runtime. Server-only. Generated projects run in Wasmer SDK sandboxes, one forked host
// process per project (src/lib/sandbox-host.mjs). Adorable alone decides packages, env and which host
// files enter a sandbox; generated code never chooses them. See docs/runtime-findings.md for limits.
import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";

import { databasePool, type DatabaseProvider } from "./database";
import { vesselHome } from "./projects";

/**
 * Stacks whose spikes passed (spikes/js). React + Vite and Next.js are not offered: see the findings doc.
 * Database stacks connect to a persistent PGlite host outside the sandbox (src/lib/database.ts), because
 * wasmer/pglite keeps its data in memory and the SDK has no host mounts.
 */
export const STACKS = {
  node: { label: "Node.js (Edge.js)", db: false },
  "node-pglite": { label: "Node.js + PostgreSQL (Edge.js + pglite)", db: true },
} as const;
export type StackId = keyof typeof STACKS;
export const isStack = (value: unknown): value is StackId => typeof value === "string" && Object.hasOwn(STACKS, value);

/** Exact registry pins; bump only after re-running spikes/js. */
export const PACKAGES = { edge: "wasmer/edgejs@0.2.5", pglite: "wasmer/pglite@0.2.0" } as const;
/** wasmer/pglite 0.2.0 has a fixed port, and guest listeners bind the same host port. */
export const PGLITE_PORT = 5432;
const GUEST_ROOT = "/workspace";
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_FILES = 20_000;
const MAX_BYTES = 256 * 1024 * 1024;
const LOG_LIMIT = 1000;

export const runtimeDirs = (projectId: string) => {
  if (!ID_PATTERN.test(projectId)) throw new SandboxError("invalid project id");
  return {
    workspace: path.join(vesselHome(), "projects", projectId, "workspace"),
    depsCache: path.join(vesselHome(), "deps"),
    wasmerCache: path.join(vesselHome(), ".wasmer"),
  };
};

export class SandboxError extends Error {}

/**
 * Map a workspace-relative path to its guest path, rejecting anything that could leave the workspace:
 * absolute paths, drive letters, `..`, empty or dot segments, NUL and backslashes.
 */
export function guestPath(relative: string): string {
  if (typeof relative !== "string" || relative.length === 0 || relative.length > 1024) throw new SandboxError("invalid path");
  if (/[\0\\]/.test(relative) || relative.startsWith("/") || /^[a-zA-Z]:/.test(relative)) throw new SandboxError(`invalid path: ${relative}`);
  const segments = relative.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) throw new SandboxError(`invalid path: ${relative}`);
  return `${GUEST_ROOT}/${relative}`;
}

/** Resolve `candidate` and fail unless it is `root` or inside it, after following symlinks. */
export async function assertInside(root: string, candidate: string): Promise<string> {
  const [realRoot, real] = await Promise.all([fs.realpath(/*turbopackIgnore: true*/ root), fs.realpath(/*turbopackIgnore: true*/ candidate)]);
  const rel = path.relative(realRoot, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new SandboxError(`path escapes ${root}`);
  return real;
}

/** Read a host directory tree (only regular files, no symlinks) into guest paths, with size limits. */
export async function readTree(root: string, guestPrefix = GUEST_ROOT, skip: readonly string[] = ["node_modules", ".git", ".provena"]) {
  const files: Record<string, Buffer> = {};
  let count = 0;
  let bytes = 0;
  async function walk(dir: string, rel: string): Promise<void> {
    for (const entry of await fs.readdir(/*turbopackIgnore: true*/ dir, { withFileTypes: true })) {
      if (skip.includes(entry.name)) continue;
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      guestPath(r); // same rules as syncFiles
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), r);
      else if (entry.isFile()) {
        const data = await fs.readFile(/*turbopackIgnore: true*/ path.join(dir, entry.name));
        if (++count > MAX_FILES || (bytes += data.length) > MAX_BYTES) throw new SandboxError("workspace too large for a sandbox");
        files[`${guestPrefix}/${r}`] = data;
      }
    }
  }
  await walk(await assertInside(root, root), "");
  return files;
}

/** Deps cache key: the workspace manifest's dependency set (deps are only reused for identical sets). */
export function depsKey(manifest: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }): string {
  const sorted = (o: Record<string, string> = {}) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  const canonical = JSON.stringify({ d: sorted(manifest.dependencies), v: sorted(manifest.devDependencies) });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

export interface SandboxSpec {
  cacheDir: string;
  app: { packages: string[]; command: string; args: string[]; env: Record<string, string>; ready: { port: number; timeoutMs: number } };
  db?: { packages: string[]; command: string; args: string[]; ready: { line: string; timeoutMs: number } };
  install?: { command: string; args: string[]; timeoutMs: number };
}

/** Everything a sandbox may run, decided by Adorable from the stack alone. */
export function planSandbox(
  stack: StackId,
  opts: { port: number; cacheDir: string; hasDeps: boolean; needsInstall: boolean; dbPort?: number },
): SandboxSpec {
  // HOST keeps guest listeners off the LAN (they bind the same host address); HOME avoids uv_os_homedir ENOENT.
  const env: Record<string, string> = { PORT: String(opts.port), HOST: "127.0.0.1", HOME: GUEST_ROOT, NODE_ENV: "development" };
  if (STACKS[stack].db) {
    if (!opts.dbPort) throw new SandboxError("database stack needs a database port");
    // Both forms: DATABASE_URL for the starters, DB_* because that is how Wasmer Edge injects a managed database.
    // PGlite serves one connection at a time, so pools stay at one connection locally.
    Object.assign(env, {
      DATABASE_URL: `postgresql://postgres@127.0.0.1:${opts.dbPort}/postgres?sslmode=disable`,
      DB_HOST: "127.0.0.1",
      DB_PORT: String(opts.dbPort),
      DB_NAME: "postgres",
      DB_USERNAME: "postgres",
      DB_PASSWORD: "",
      DB_POOL_MAX: "1",
    });
  }
  return {
    cacheDir: opts.cacheDir,
    app: { packages: [PACKAGES.edge], command: "edge", args: [`${GUEST_ROOT}/server.js`], env, ready: { port: opts.port, timeoutMs: 60_000 } },
    ...(opts.hasDeps && opts.needsInstall && { install: { command: "pnpm", args: ["install", "--ignore-scripts", "--reporter=append-only"], timeoutMs: 300_000 } }),
  };
}

export type SandboxState = "starting" | "running" | "restarting" | "stopped" | "crashed";
export interface LogEntry { at: number; source: string; stream: string; line: string }

/** Allowed state transitions; anything else is a bug or a racing call and is rejected. */
const TRANSITIONS: Record<SandboxState, readonly SandboxState[]> = {
  starting: ["running", "crashed", "stopped"],
  running: ["restarting", "crashed", "stopped"],
  restarting: ["running", "crashed", "stopped"],
  crashed: ["restarting", "stopped"],
  stopped: [],
};
export const canTransition = (from: SandboxState, to: SandboxState) => TRANSITIONS[from].includes(to);

type Reply = { id: number; ok: boolean; error?: string };
type HostMessage = Partial<Reply> & { log?: Omit<LogEntry, "at">; exit?: { source: string; code: number; reason: string } };
/** "run" hosts execute guest code; the one-off "warm" host only downloads packages into the cache. */
export type HostMode = "run" | "warm";
export type ForkHost = (cacheDir: string, mode: HostMode) => ChildProcess;

/**
 * Node flags for a sandbox host. Guest JS in Edge.js can reach the host `process` (see the Security model
 * in docs/runtime-findings.md), so hosts run under Node's permission model. Every flag here was checked
 * by spikes/js/f-permission.mjs: run hosts may only read the SDK code and the Wasmer cache (opened
 * read-only); they get no fs writes, child processes, addons, WASI or inspector. `--allow-worker` is
 * required by the SDK. Only the warm host, which runs no guest code, may write the cache.
 */
export function hostExecArgv(paths: { nodeModules: string; hostScript: string; cacheDir: string }, mode: HostMode): string[] {
  return [
    "--experimental-wasm-jspi", // Node 24 rejects this in NODE_OPTIONS; the SDK needs JSPI
    "--permission",
    `--allow-fs-read=${paths.nodeModules}`,
    `--allow-fs-read=${paths.hostScript}`,
    `--allow-fs-read=${paths.cacheDir}`,
    "--allow-worker",
    ...(mode === "warm" ? [`--allow-fs-write=${paths.cacheDir}`] : []),
  ];
}

/** Host env: no API keys or user secrets, only what Windows networking and temp files need. */
export function hostEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["SystemRoot", "windir", "TEMP", "TMP", "PATH"]) if (source[key]) env[key] = source[key]!;
  return env;
}

export const forkHost: ForkHost = (cacheDir, mode) => {
  const hostScript = path.join(process.cwd(), "src", "lib", "sandbox-host.mjs");
  return fork(/*turbopackIgnore: true*/ hostScript, [], {
    execArgv: hostExecArgv({ nodeModules: path.join(process.cwd(), "node_modules"), hostScript, cacheDir }, mode),
    env: hostEnv() as NodeJS.ProcessEnv, // Next types NODE_ENV as required; the host gets none on purpose
    cwd: process.cwd(),
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
};

/** Download packages into the shared cache in a short-lived host that never runs guest code. */
async function warmCache(forkFn: ForkHost, cacheDir: string, packages: string[]): Promise<void> {
  const child = forkFn(cacheDir, "warm");
  try {
    await new Promise<void>((resolve, reject) => {
      child.on("message", (m: HostMessage) => (m.id === 1 ? (m.ok ? resolve() : reject(new SandboxError(m.error ?? "package download failed"))) : undefined));
      child.on("exit", (code) => reject(new SandboxError(`package download host exited (${code})`)));
      child.send({ id: 1, op: "warm", cacheDir, packages });
    });
  } finally {
    child.kill();
  }
}

/** One project's live sandbox. Create through SandboxPool. */
export class ProjectSandbox extends EventEmitter {
  state: SandboxState = "starting";
  readonly logs: LogEntry[] = [];
  error?: string;
  #child?: ChildProcess;
  #seq = 0;
  #pending = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly projectId: string,
    readonly stack: StackId,
    readonly port: number,
    private readonly forkFn: ForkHost,
    private readonly onStopped: () => void,
  ) {
    super();
  }

  /**
   * The preview URL. Deliberately `localhost`, not 127.0.0.1: browsers send cookies regardless of port, so
   * serving the untrusted app from Adorable's own host (127.0.0.1) would hand it Adorable's session cookie.
   */
  get appUrl() {
    return `http://localhost:${this.port}/`;
  }

  /** Subscribe to log lines; returns an unsubscribe function. */
  onLog(listener: (entry: LogEntry) => void): () => void {
    this.on("log", listener);
    return () => this.off("log", listener);
  }

  #setState(next: SandboxState) {
    if (!canTransition(this.state, next)) throw new SandboxError(`cannot go from ${this.state} to ${next}`);
    this.state = next;
    this.emit("state", next);
  }

  #log(source: string, stream: string, line: string) {
    const entry = { at: Date.now(), source, stream, line };
    this.logs.push(entry);
    if (this.logs.length > LOG_LIMIT) this.logs.splice(0, this.logs.length - LOG_LIMIT);
    this.emit("log", entry);
  }

  #spawnHost(cacheDir: string) {
    const child = this.forkFn(cacheDir, "run");
    this.#child = child;
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => chunk.split("\n").filter(Boolean).forEach((l) => this.#log("host", "stderr", l)));
    child.on("message", (m: HostMessage) => {
      if (m.log) this.#log(m.log.source, m.log.stream, m.log.line);
      else if (m.exit) {
        this.#log(m.exit.source, "exit", `exited (${m.exit.reason}, code ${m.exit.code})`);
        if (m.exit.source === "app" && this.state === "running") this.#fail(`app exited with code ${m.exit.code}`);
      } else if (typeof m.id === "number") {
        const waiter = this.#pending.get(m.id);
        this.#pending.delete(m.id);
        if (m.ok) waiter?.resolve();
        else waiter?.reject(new SandboxError(m.error ?? "sandbox host error"));
      }
    });
    child.on("exit", (code) => {
      if (this.#child !== child) return;
      this.#child = undefined;
      for (const waiter of this.#pending.values()) waiter.reject(new SandboxError(`sandbox host exited (${code})`));
      this.#pending.clear();
      if (this.state !== "stopped") this.#fail(`sandbox host exited (${code})`);
    });
  }

  #fail(message: string) {
    this.error = message;
    this.#log("vessel", "error", message);
    if (canTransition(this.state, "crashed")) this.#setState("crashed");
  }

  #call(op: string, args: Record<string, unknown> = {}): Promise<void> {
    const child = this.#child;
    if (!child?.connected) return Promise.reject(new SandboxError("sandbox host is not running"));
    const id = ++this.#seq;
    return new Promise<void>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      child.send({ id, op, ...args });
    });
  }

  /** Serialize lifecycle operations so restart/sync/stop never interleave. */
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(fn, fn);
    this.#queue = next.catch(() => {});
    return next;
  }

  async boot(spec: SandboxSpec, files: Record<string, Buffer>): Promise<void> {
    return this.#serial(async () => {
      this.#spawnHost(spec.cacheDir);
      try {
        await this.#call("start", { spec, files: encode(files) });
        this.#setState("running");
      } catch (e) {
        this.#fail((e as Error).message);
        // Carry the last log lines so the caller (and the UI) can show why the boot failed.
        const tail = this.logs.slice(-15).map((l) => `[${l.source}] ${l.line}`).join("\n");
        throw new SandboxError(tail ? `${(e as Error).message}\n${tail}` : (e as Error).message);
      }
    });
  }

  /** Copy changed workspace files into the guest; `null` deletes. Restart to pick up server code changes. */
  async syncFiles(changed: Record<string, Buffer | string | null>): Promise<void> {
    const files = Object.fromEntries(Object.entries(changed).map(([rel, data]) => [guestPath(rel), data === null ? null : Buffer.from(data)]));
    return this.#serial(() => this.#call("write", { files: encode(files) }));
  }

  /** Restart the app process. Wired to the preview's `onRestart`. Database data persists (it lives outside). */
  restart(): Promise<void> {
    return this.#lifecycle("restart");
  }

  #lifecycle(op: "restart"): Promise<void> {
    return this.#serial(async () => {
      if (this.state === "stopped") throw new SandboxError("sandbox is stopped");
      this.#setState("restarting");
      this.error = undefined;
      try {
        await this.#call(op);
        this.#setState("running");
      } catch (e) {
        this.#fail((e as Error).message);
        throw e;
      }
    });
  }

  stop(): Promise<void> {
    return this.#serial(async () => {
      if (this.state === "stopped") return;
      this.#setState("stopped");
      const child = this.#child;
      if (child?.connected) {
        const exited = new Promise((r) => child.once("exit", r));
        await Promise.race([this.#call("stop").catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
        await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
      }
      child?.kill();
      this.onStopped();
    });
  }
}

const encode = (files: Record<string, Buffer | null>) =>
  Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v === null ? null : v.toString("base64")]));

export async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Per-project sandbox pool. One instance per server process (see `sandboxPool`). */
export class SandboxPool {
  #sandboxes = new Map<string, ProjectSandbox>();

  constructor(
    private readonly forkFn: ForkHost = forkHost,
    private readonly ports: () => Promise<number> = reservePort,
    private readonly database: DatabaseProvider = databasePool(),
  ) {}

  get(projectId: string): ProjectSandbox | undefined {
    return this.#sandboxes.get(projectId);
  }

  #starting = new Map<string, Promise<ProjectSandbox>>();
  #warmed = new Map<string, Promise<void>>();

  /** Run hosts open the cache read-only, so packages are fetched once per server process first. */
  #warm(spec: SandboxSpec): Promise<void> {
    const packages = [...spec.app.packages];
    const key = `${spec.cacheDir}|${packages.join(",")}`;
    let warming = this.#warmed.get(key);
    if (!warming) {
      warming = warmCache(this.forkFn, spec.cacheDir, packages);
      warming.catch(() => this.#warmed.delete(key)); // retry next time
      this.#warmed.set(key, warming);
    }
    return warming;
  }

  /** Start (or return the running) sandbox for a project, seeded from its workspace directory. */
  start(projectId: string, stack: StackId): Promise<ProjectSandbox> {
    // Concurrent calls for one project share a single boot instead of racing to create two sandboxes.
    const inFlight = this.#starting.get(projectId);
    if (inFlight) return inFlight;
    const started = this.#start(projectId, stack).finally(() => this.#starting.delete(projectId));
    this.#starting.set(projectId, started);
    return started;
  }

  async #start(projectId: string, stack: StackId): Promise<ProjectSandbox> {
    if (!isStack(stack)) throw new SandboxError(`unsupported stack: ${String(stack)}`);
    const existing = this.#sandboxes.get(projectId);
    if (existing && existing.state !== "stopped") {
      if (existing.stack !== stack) throw new SandboxError(`project already running as ${existing.stack}`);
      return existing;
    }
    const dirs = runtimeDirs(projectId);
    const dbPort = STACKS[stack].db ? await this.database.start(projectId) : undefined;
    const sandbox = new ProjectSandbox(projectId, stack, await this.ports(), this.forkFn, () => {
      if (this.#sandboxes.get(projectId) === sandbox) this.#sandboxes.delete(projectId);
    });
    this.#sandboxes.set(projectId, sandbox);
    try {
      const files = await readTree(dirs.workspace);
      const deps = await this.#cachedDeps(dirs, files);
      Object.assign(files, deps.files);
      const spec = planSandbox(stack, { port: sandbox.port, cacheDir: dirs.wasmerCache, hasDeps: deps.hasDeps, needsInstall: !deps.cached, dbPort });
      await this.#warm(spec);
      await sandbox.boot(spec, files);
    } catch (e) {
      await sandbox.stop().catch(() => {});
      throw e;
    }
    return sandbox;
  }

  /**
   * Reuse a pre-installed node_modules from the shared deps cache (`<deps>/<depsKey>/node_modules`, filled by
   * scripts/warm-deps.mjs) when one matches the manifest; otherwise the guest runs pnpm install.
   */
  async #cachedDeps(dirs: ReturnType<typeof runtimeDirs>, files: Record<string, Buffer>) {
    const manifest = files[`${GUEST_ROOT}/package.json`];
    if (!manifest) return { hasDeps: false, cached: false, files: {} };
    const parsed = JSON.parse(manifest.toString("utf8"));
    const hasDeps = Object.keys({ ...parsed.dependencies, ...parsed.devDependencies }).length > 0;
    const entry = path.join(dirs.depsCache, depsKey(parsed));
    try {
      await assertInside(dirs.depsCache, entry);
      return { hasDeps, cached: true, files: await readTree(path.join(entry, "node_modules"), `${GUEST_ROOT}/node_modules`, [".cache"]) };
    } catch {
      return { hasDeps, cached: false, files: {} };
    }
  }

  /** Wipe the project's database and boot the app again on the fresh one. Wired to the preview's `onResetData`. */
  async resetData(projectId: string): Promise<ProjectSandbox> {
    const sandbox = this.#sandboxes.get(projectId);
    if (!sandbox) throw new SandboxError("sandbox is not running");
    if (!STACKS[sandbox.stack].db) throw new SandboxError("this stack has no database");
    await sandbox.stop();
    await this.database.reset(projectId);
    return this.start(projectId, sandbox.stack);
  }

  /** Stop the app. The database keeps running (and keeps its data) unless `withDatabase` is set. */
  async stop(projectId: string, { withDatabase = false } = {}): Promise<void> {
    await this.#sandboxes.get(projectId)?.stop();
    if (withDatabase) await this.database.stop(projectId);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.#sandboxes.values()].map((s) => s.stop()));
  }
}

const globalPool = globalThis as typeof globalThis & { __vesselSandboxPool?: SandboxPool };
/** The server's pool, kept across dev hot reloads so sandboxes are not orphaned. */
export const sandboxPool = (): SandboxPool => (globalPool.__vesselSandboxPool ??= new SandboxPool());
