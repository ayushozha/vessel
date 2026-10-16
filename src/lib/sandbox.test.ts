import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertInside, canTransition, depsKey, guestPath, hostEnv, hostExecArgv, PACKAGES, planSandbox, readTree, SandboxError, SandboxPool, type HostMode, type SandboxSpec } from "./sandbox";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

/** A database provider that records calls and hands out a new port after each reset. */
function fakeDb() {
  const calls: string[] = [];
  let port = 5500;
  return {
    calls,
    provider: {
      start: async (id: string) => (calls.push(`start:${id}`), port),
      reset: async (id: string) => {
        calls.push(`reset:${id}`);
        port += 1;
      },
      stop: async (id: string) => void calls.push(`stop:${id}`),
    },
  };
}
const OTHER = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

/** A fake sandbox host: answers every op, records what it was sent, and can fail ops or crash on demand. */
function fakeHost(behaviour: { failOps?: string[] } = {}) {
  const sent: { op: string; spec?: SandboxSpec; files?: Record<string, string | null> }[] = [];
  const children: EventEmitter[] = [];
  const warms: { cacheDir: string; packages: string[] }[] = [];
  const forkFn = (_cacheDir: string, mode: HostMode) => {
    const child = Object.assign(new EventEmitter(), {
      connected: true,
      stderr: null,
      kill: () => child.emit("exit", 0),
      send(message: { id: number; op: string; cacheDir?: string; packages?: string[] }) {
        if (mode === "warm") warms.push({ cacheDir: message.cacheDir!, packages: message.packages! });
        else sent.push(message);
        setImmediate(() => {
          if (behaviour.failOps?.includes(message.op)) child.emit("message", { id: message.id, ok: false, error: `${message.op} failed` });
          else child.emit("message", { id: message.id, ok: true });
          if (message.op === "stop") child.kill();
        });
        return true;
      },
    });
    if (mode === "run") children.push(child);
    return child as unknown as ChildProcess;
  };
  return { forkFn, sent, children, warms };
}

let home: string;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "vessel-sandbox-"));
  process.env.VESSEL_HOME = home;
});
afterEach(async () => {
  delete process.env.VESSEL_HOME;
  await fs.rm(home, { recursive: true, force: true });
});

async function workspace(id: string, files: Record<string, string>) {
  const dir = path.join(home, "projects", id, "workspace");
  for (const [rel, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), text);
  }
  return dir;
}

describe("guestPath", () => {
  it("maps workspace-relative paths under /workspace", () => {
    expect(guestPath("server.js")).toBe("/workspace/server.js");
    expect(guestPath("src/app/page.tsx")).toBe("/workspace/src/app/page.tsx");
  });

  it.each(["", "/etc/passwd", "../secrets", "a/../../b", "a//b", "./a", "a/.", "C:/Windows", "c:evil", "a\\b", "a\0b", "x".repeat(1025)])(
    "rejects %j",
    (p) => expect(() => guestPath(p)).toThrow(SandboxError),
  );
});

describe("assertInside", () => {
  it("allows the root and its children, rejects siblings and symlink escapes", async () => {
    const root = await workspace(ID, { "a.txt": "a" });
    const outside = await workspace(OTHER, { "secret.txt": "s" });
    expect(await assertInside(root, root)).toBe(await fs.realpath(root));
    await expect(assertInside(root, path.join(root, "a.txt"))).resolves.toContain("a.txt");
    await expect(assertInside(root, outside)).rejects.toThrow(SandboxError);
    await expect(assertInside(root, path.join(root, "..", ".."))).rejects.toThrow(SandboxError);
    const link = path.join(root, "link");
    try {
      await fs.symlink(outside, link, "junction");
    } catch {
      return; // symlinks unavailable on this machine
    }
    await expect(assertInside(root, link)).rejects.toThrow(SandboxError);
  });
});

describe("readTree", () => {
  it("reads regular files into guest paths and skips node_modules and .git", async () => {
    const root = await workspace(ID, { "server.js": "x", "lib/db.js": "y", "node_modules/pg/index.js": "z", ".git/HEAD": "h" });
    expect(Object.keys(await readTree(root)).sort()).toEqual(["/workspace/lib/db.js", "/workspace/server.js"]);
  });
});

describe("depsKey", () => {
  it("is order-independent and changes with versions", () => {
    const a = depsKey({ dependencies: { express: "5.2.1", pg: "8.23.0" } });
    expect(depsKey({ dependencies: { pg: "8.23.0", express: "5.2.1" } })).toBe(a);
    expect(depsKey({ dependencies: { express: "5.2.1", pg: "8.22.0" } })).not.toBe(a);
    expect(depsKey({ dependencies: { express: "5.2.1" }, devDependencies: { pg: "8.23.0" } })).not.toBe(a);
  });

  it("matches scripts/warm-deps.mjs, which fills the cache", async () => {
    const script: { depsKey: typeof depsKey } = await import("../../scripts/warm-deps.mjs");
    const manifest = { dependencies: { express: "5.2.1", pg: "8.23.0" }, devDependencies: { vite: "7.3.6" } };
    expect(script.depsKey(manifest)).toBe(depsKey(manifest));
  });
});

describe("planSandbox", () => {
  it("only uses pinned packages and Vessel-chosen env", () => {
    const spec = planSandbox("node-pglite", { port: 4100, cacheDir: "/c", hasDeps: true, needsInstall: true, dbPort: 5500 });
    expect(spec.app.packages).toEqual([PACKAGES.edge]);
    expect(spec.db).toBeUndefined(); // the database runs outside the sandbox (src/lib/database.ts)
    expect(spec.app.env).toEqual({
      PORT: "4100",
      HOST: "127.0.0.1",
      HOME: "/workspace",
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://postgres@127.0.0.1:5500/postgres?sslmode=disable",
      DB_HOST: "127.0.0.1",
      DB_PORT: "5500",
      DB_NAME: "postgres",
      DB_USERNAME: "postgres",
      DB_PASSWORD: "",
      DB_POOL_MAX: "1",
    });
    expect(spec.install?.args).toContain("--ignore-scripts");
    expect(() => planSandbox("node-pglite", { port: 1, cacheDir: "/c", hasDeps: false, needsInstall: false })).toThrow("database port");
  });

  it("skips the database and install when not needed", () => {
    const spec = planSandbox("node", { port: 1, cacheDir: "/c", hasDeps: true, needsInstall: false });
    expect(spec.db).toBeUndefined();
    expect(spec.install).toBeUndefined();
    expect(spec.app.env.DATABASE_URL).toBeUndefined();
  });
});

describe("host hardening", () => {
  const paths = { nodeModules: "/repo/node_modules", hostScript: "/repo/src/lib/sandbox-host.mjs", cacheDir: "/home/.wasmer" };

  it("runs guest hosts under the permission model with read-only access only", () => {
    const flags = hostExecArgv(paths, "run");
    expect(flags).toEqual([
      "--experimental-wasm-jspi",
      "--permission",
      "--allow-fs-read=/repo/node_modules",
      "--allow-fs-read=/repo/src/lib/sandbox-host.mjs",
      "--allow-fs-read=/home/.wasmer",
      "--allow-worker",
    ]);
    expect(flags.join(" ")).not.toMatch(/allow-fs-write|allow-child-process|allow-addons|allow-wasi|allow-inspector/);
  });

  it("lets only the warm host write the cache", () => {
    expect(hostExecArgv(paths, "warm")).toContain("--allow-fs-write=/home/.wasmer");
  });

  it("passes no secrets to the host environment", () => {
    const env = hostEnv({ PATH: "/bin", SystemRoot: "C:/Windows", OPENAI_API_KEY: "sk-x", USERPROFILE: "C:/Users/me", HOME: "/home/me", NODE_ENV: "development" });
    expect(env).toEqual({ PATH: "/bin", SystemRoot: "C:/Windows" });
  });
});

describe("lifecycle transitions", () => {
  it("allows the expected edges only", () => {
    expect(canTransition("starting", "running")).toBe(true);
    expect(canTransition("running", "restarting")).toBe(true);
    expect(canTransition("crashed", "restarting")).toBe(true);
    expect(canTransition("stopped", "running")).toBe(false);
    expect(canTransition("starting", "restarting")).toBe(false);
  });
});

describe("SandboxPool", () => {
  const ports = async () => 4321;

  it("starts with workspace files, syncs, restarts, resets data and stops", async () => {
    await workspace(ID, { "server.js": "console.log(1)", "package.json": JSON.stringify({ dependencies: { pg: "8.23.0" } }) });
    const host = fakeHost();
    const db = fakeDb();
    const pool = new SandboxPool(host.forkFn, ports, db.provider);
    const sb = await pool.start(ID, "node-pglite");
    expect(sb.state).toBe("running");
    expect(sb.appUrl).toBe("http://127.0.0.1:4321/");
    const start = host.sent[0];
    expect(Object.keys(start.files ?? {}).sort()).toEqual(["/workspace/package.json", "/workspace/server.js"]);
    expect(start.spec?.install).toBeDefined(); // nothing in the deps cache, so the guest installs

    await sb.syncFiles({ "server.js": "console.log(2)", "old.js": null });
    expect(host.sent[1]).toMatchObject({ op: "write", files: { "/workspace/server.js": Buffer.from("console.log(2)").toString("base64"), "/workspace/old.js": null } });
    await expect(sb.syncFiles({ "../escape.js": "x" })).rejects.toThrow(SandboxError);

    await sb.restart();
    expect(sb.state).toBe("running");
    expect(start.spec?.app.env.DB_PORT).toBe("5500");

    // Reset data: stop the app, wipe the database, boot again on the fresh database's port.
    const fresh = await pool.resetData(ID);
    expect(sb.state).toBe("stopped");
    expect(fresh).not.toBe(sb);
    expect(fresh.state).toBe("running");
    expect(db.calls).toEqual([`start:${ID}`, `reset:${ID}`, `start:${ID}`]);
    expect(host.sent.at(-1)).toMatchObject({ op: "start" });
    expect(host.sent.at(-1)?.spec?.app.env.DB_PORT).toBe("5501");

    expect(await pool.start(ID, "node-pglite")).toBe(fresh);
    await pool.stop(ID, { withDatabase: true });
    expect(fresh.state).toBe("stopped");
    expect(db.calls.at(-1)).toBe(`stop:${ID}`);
    expect(pool.get(ID)).toBeUndefined();
    await expect(fresh.restart()).rejects.toThrow("stopped");
  });

  it("warms the package cache once per package set before booting", async () => {
    await workspace(ID, { "server.js": "x" });
    await workspace(OTHER, { "server.js": "x" });
    const host = fakeHost();
    const pool = new SandboxPool(host.forkFn, ports, fakeDb().provider);
    await pool.start(ID, "node-pglite");
    await pool.start(OTHER, "node");
    await pool.stop(OTHER);
    await pool.start(OTHER, "node");
    expect(host.warms.map((w) => w.packages)).toEqual([[PACKAGES.edge]]); // one package set, warmed once
    expect(host.warms[0].cacheDir).toBe(path.join(home, ".wasmer"));
  });

  it("fails the start when packages cannot be downloaded, and retries next time", async () => {
    await workspace(ID, { "server.js": "x" });
    const failing = fakeHost({ failOps: ["warm"] });
    const pool = new SandboxPool(failing.forkFn, ports, fakeDb().provider);
    await expect(pool.start(ID, "node")).rejects.toThrow("warm failed");
    expect(pool.get(ID)).toBeUndefined();
    await expect(pool.start(ID, "node")).rejects.toThrow("warm failed");
    expect(failing.children).toHaveLength(0); // no guest host was started
  });

  it("shares one boot between concurrent starts of the same project", async () => {
    await workspace(ID, { "server.js": "x" });
    const host = fakeHost();
    const pool = new SandboxPool(host.forkFn, ports, fakeDb().provider);
    const [a, b] = await Promise.all([pool.start(ID, "node"), pool.start(ID, "node")]);
    expect(a).toBe(b);
    expect(host.children).toHaveLength(1);
  });

  it("reuses a matching deps cache entry instead of installing", async () => {
    const manifest = { dependencies: { express: "5.2.1" } };
    await workspace(ID, { "server.js": "x", "package.json": JSON.stringify(manifest) });
    const cached = path.join(home, "deps", depsKey(manifest), "node_modules", "express");
    await fs.mkdir(cached, { recursive: true });
    await fs.writeFile(path.join(cached, "index.js"), "module.exports = 1");
    const host = fakeHost();
    await new SandboxPool(host.forkFn, ports, fakeDb().provider).start(ID, "node");
    expect(host.sent[0].spec?.install).toBeUndefined();
    expect(host.sent[0].files).toHaveProperty(["/workspace/node_modules/express/index.js"]);
  });

  it("gives every database project its own database, so several can run at once", async () => {
    await workspace(ID, { "server.js": "x" });
    await workspace(OTHER, { "server.js": "x" });
    const db = fakeDb();
    const pool = new SandboxPool(fakeHost().forkFn, ports, db.provider);
    await pool.start(ID, "node-pglite");
    await pool.start(OTHER, "node-pglite");
    expect(db.calls).toEqual([`start:${ID}`, `start:${OTHER}`]);
    await expect(pool.start(OTHER, "node")).rejects.toThrow("already running as node-pglite");
  });

  it("rejects unknown stacks, bad ids and resetData without a database", async () => {
    await workspace(ID, { "server.js": "x" });
    const pool = new SandboxPool(fakeHost().forkFn, ports, fakeDb().provider);
    await expect(pool.start(ID, "vite" as never)).rejects.toThrow("unsupported stack");
    await expect(pool.start("../../etc", "node")).rejects.toThrow("invalid project id");
    await pool.start(ID, "node");
    await expect(pool.resetData(ID)).rejects.toThrow("no database");
    await expect(pool.resetData(OTHER)).rejects.toThrow("not running");
  });

  it("cleans up when the host fails to start, and marks crashes", async () => {
    await workspace(ID, { "server.js": "x" });
    const failing = new SandboxPool(fakeHost({ failOps: ["start"] }).forkFn, ports, fakeDb().provider);
    await expect(failing.start(ID, "node-pglite")).rejects.toThrow("start failed");
    expect(failing.get(ID)).toBeUndefined();

    const host = fakeHost();
    const pool = new SandboxPool(host.forkFn, ports, fakeDb().provider);
    await pool.start(ID, "node-pglite");
    const sb = pool.get(ID)!;
    const states: string[] = [];
    sb.on("state", (s) => states.push(s));
    host.children[0].emit("exit", 1);
    expect(sb.state).toBe("crashed");
    expect(sb.error).toContain("exited");
    expect(sb.logs.at(-1)?.line).toContain("exited");
    expect(states).toEqual(["crashed"]);
  });

  it("streams logs to subscribers and keeps a bounded buffer", async () => {
    await workspace(ID, { "server.js": "x" });
    const host = fakeHost();
    const sb = await new SandboxPool(host.forkFn, ports, fakeDb().provider).start(ID, "node");
    const seen: string[] = [];
    const off = sb.onLog((e) => seen.push(e.line));
    for (let i = 0; i < 1005; i++) host.children[0].emit("message", { log: { source: "app", stream: "stdout", line: `l${i}` } });
    off();
    host.children[0].emit("message", { log: { source: "app", stream: "stdout", line: "after" } });
    expect(seen).toHaveLength(1005);
    expect(sb.logs).toHaveLength(1000);
    expect(sb.logs.at(-1)?.line).toBe("after");
  });
});
