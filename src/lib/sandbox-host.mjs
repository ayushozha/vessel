// Per-project sandbox host. Forked by src/lib/sandbox.ts as a plain Node child (never bundled by Next).
// It owns one Wasmer client so an SDK worker failure, or guest code escaping Edge.js (see
// docs/runtime-findings.md), lands in this process with its scrubbed environment, not in the Vessel server.
// Protocol (process IPC): parent sends { id, op, ...args }; child replies { id, ok, error? } and emits
// { log: { source, stream, line } } and { exit: { source, code, reason } }.
import { Wasmer } from "@wasmer/sdk/node";

const send = (message) => process.send?.(message);
const log = (source, stream, line) => send({ log: { source, stream, line } });

/** @type {import("@wasmer/sdk/node").Wasmer | null} */
let wasmer = null;
/** @type {any} */
let spec = null;
const boxes = {}; // role -> Sandbox
const procs = {}; // role -> Process

async function pipeLines(source, stream, readable) {
  try {
    for await (const line of readable.lines()) log(source, stream, line);
  } catch {
    // The stream ends with its process.
  }
}

/** Spawn one role's process and resolve once it reports ready. */
async function spawn(role) {
  const def = spec[role];
  const proc = await boxes[role].command(def.command, def.args, { cwd: "/workspace" }).spawn({ stdout: "pipe", stderr: "pipe" });
  procs[role] = proc;
  void pipeLines(role, "stdout", proc.stdout);
  const ready = def.ready.line ? waitForLine(proc.stderr, role, def.ready.line, def.ready.timeoutMs) : pipeLines(role, "stderr", proc.stderr);
  const exited = proc.wait().then((out) => {
    if (procs[role] === proc) delete procs[role];
    send({ exit: { source: role, code: out.exitCode, reason: out.reason } });
    throw new Error(`${role} exited before it was ready (code ${out.exitCode})`);
  });
  exited.catch(() => {}); // only meaningful while waiting for readiness
  await Promise.race([def.ready.port ? boxes[role].ports.wait(def.ready.port, { timeoutMs: def.ready.timeoutMs }) : ready, exited]);
}

/** Wait for a marker on a stream (logging every line), then keep draining it. */
function waitForLine(readable, source, marker, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${source} not ready after ${timeoutMs}ms`)), timeoutMs);
    void (async () => {
      let seen = false;
      for await (const line of readable.lines()) {
        log(source, "stderr", line);
        if (!seen && line.includes(marker)) {
          seen = true;
          clearTimeout(timer);
          resolve();
        }
      }
      if (!seen) {
        clearTimeout(timer);
        reject(new Error(`${source} exited before it was ready`));
      }
    })().catch(reject);
  });
}

async function stopRole(role) {
  const proc = procs[role];
  if (!proc) return;
  delete procs[role];
  await proc.terminate({ gracePeriodMs: 1000 }).catch(() => {});
  await proc.wait().catch(() => {});
}

async function startAll() {
  // pglite serves one connection per process and exits when it closes, so the database starts first.
  if (spec.db) await spawn("db");
  await spawn("app");
}

const ops = {
  async start(args) {
    spec = args.spec;
    wasmer = new Wasmer({ cache: { directory: spec.cacheDir }, outputBytes: 256 * 1024 });
    if (spec.db) boxes.db = await wasmer.sandboxes.create({ packages: spec.db.packages, network: { mode: "host" } });
    boxes.app = await wasmer.sandboxes.create({ packages: spec.app.packages, files: decode(args.files), env: spec.app.env, network: { mode: "host" } });
    if (spec.install) {
      log("install", "stdout", `$ ${[spec.install.command, ...spec.install.args].join(" ")}`);
      const out = await boxes.app.command(spec.install.command, spec.install.args, { cwd: "/workspace" }).run({ check: false, timeoutMs: spec.install.timeoutMs });
      for (const line of `${out.stdout.text()}${out.stderr.text()}`.split("\n").filter(Boolean).slice(-50)) log("install", "stdout", line);
      if (!out.ok) throw new Error(`dependency install failed (exit ${out.exitCode})`);
    }
    await startAll();
  },
  async write(args) {
    for (const [file, contents] of Object.entries(decode(args.files))) {
      if (contents === null) await boxes.app.fs.remove(file).catch(() => {});
      else {
        await boxes.app.fs.mkdir(file.slice(0, file.lastIndexOf("/")) || "/workspace", { recursive: true });
        await boxes.app.fs.writeFile(file, contents);
      }
    }
  },
  async restart() {
    await stopRole("app");
    await stopRole("db");
    await startAll();
  },
  async resetData() {
    // pglite keeps PGDATA in a per-process overlay: a fresh pglite process is a fresh database.
    await ops.restart();
  },
  async stop() {
    await stopRole("app");
    await stopRole("db");
    for (const box of Object.values(boxes)) await box.close().catch(() => {});
    await wasmer?.close().catch(() => {});
    setImmediate(() => process.exit(0));
  },
};

/** Files cross IPC as base64 so binary content survives JSON serialization; null deletes. */
function decode(files = {}) {
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v === null ? null : Buffer.from(v, "base64")]));
}

process.on("message", async (message) => {
  const op = ops[message.op];
  try {
    if (!op) throw new Error(`unknown op ${message.op}`);
    await op(message);
    send({ id: message.id, ok: true });
  } catch (error) {
    send({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
process.on("disconnect", () => process.exit(0));
