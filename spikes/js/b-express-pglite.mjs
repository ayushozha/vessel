// Spike (b): Express + `pg` on Edge.js talking to PostgreSQL (wasmer/pglite) in a second sandbox.
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newWasmer, PKG, reservePort, waitForLine, drain, readTree, now, ms } from "./lib.mjs";

const app = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "express-pg");
execSync("npm install --ignore-scripts --no-audit --no-fund --silent", { cwd: app, stdio: "inherit" });
const port = await reservePort();
const t0 = now();
const wasmer = newWasmer();
const dbBox = await wasmer.sandboxes.create({ packages: [PKG.pglite], network: { mode: "host" } });
const appBox = await wasmer.sandboxes.create({
  packages: [PKG.edge],
  files: await readTree(app),
  env: { PORT: String(port), HOST: "127.0.0.1", DATABASE_URL: "postgresql://postgres@127.0.0.1:5432/postgres?sslmode=disable" },
  network: { mode: "host" },
});
let pgProc, appProc;
try {
  let t = now();
  pgProc = await dbBox.command("pglite").spawn({ stdout: "capture", stderr: "pipe" });
  await waitForLine(pgProc.stderr.lines(), "OLIPHAUNT_WASIX_SOCKET_READY 5432", 30_000);
  console.log(`pglite ready: ${ms(t)}`);
  t = now();
  appProc = await appBox.command("edge", ["/workspace/server.js"], { cwd: "/workspace" }).spawn({ stdout: "pipe", stderr: "pipe" });
  drain(appProc.stderr.lines(), "app-err");
  await waitForLine(appProc.stdout.lines(), "listening on", 60_000, "app");
  console.log(`app ready (connected + CREATE TABLE): ${ms(t)}`);
  const call = async (method, p, body) => {
    const t1 = now();
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { "content-type": "application/json", connection: "close" }, body: body && JSON.stringify(body) });
    const text = await r.text();
    console.log(`${method} ${p} -> ${r.status} ${text.slice(0, 160)} ${ms(t1)}`);
    if (!r.ok) throw new Error(`${method} ${p} ${r.status}`);
    return JSON.parse(text);
  };
  await call("GET", "/api/version");
  await call("POST", "/api/todos", { title: "run postgres in wasm" });
  await call("POST", "/api/todos", { title: "ship it" });
  const rows = await call("GET", "/api/todos");
  if (rows.length !== 2) throw new Error(`expected 2 rows, got ${rows.length}`);
  await call("GET", "/api/todos");

  // Restart: pglite exits when its only client disconnects, so an app restart must respawn it.
  // PGDATA lives in the package's per-process writable overlay, so a respawn starts from the
  // package's pristine database (observed in 0.2.0); the app recreates its schema on boot.
  t = now();
  await appProc.terminate({ gracePeriodMs: 1000 });
  await pgProc.wait();
  pgProc = await dbBox.command("pglite").spawn({ stdout: "capture", stderr: "pipe" });
  await waitForLine(pgProc.stderr.lines(), "OLIPHAUNT_WASIX_SOCKET_READY 5432", 30_000);
  appProc = await appBox.command("edge", ["/workspace/server.js"], { cwd: "/workspace" }).spawn({ stdout: "pipe", stderr: "pipe" });
  drain(appProc.stderr.lines(), "app-err");
  await waitForLine(appProc.stdout.lines(), "listening on", 60_000, "app");
  console.log(`restart (app + pglite, same sandboxes): ${ms(t)}`);
  const after = await call("GET", "/api/todos");
  console.log(`rows after pglite respawn: ${after.length} (data ${after.length === 2 ? "persisted" : "reset: per-process PGDATA"})`);
  console.log(`RESULT b-express-pglite PASS total ${ms(t0)}`);
} catch (e) {
  console.log(`RESULT b-express-pglite FAIL ${e.message}`);
  process.exitCode = 1;
} finally {
  await appProc?.terminate({ gracePeriodMs: 1000 });
  // After its only client disconnects, pglite should exit on its own; record what it does.
  const exited = await Promise.race([pgProc?.wait().then((o) => `exited ${o.exitCode}/${o.reason}`), new Promise((r) => setTimeout(() => r("still running after 3s"), 3000))]);
  console.log(`pglite after client disconnect: ${exited}`);
  await pgProc?.kill().catch(() => {});
  await appBox.close();
  await dbBox.close();
  await wasmer.close();
}
