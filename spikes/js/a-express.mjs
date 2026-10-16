// Spike (a): Express JSON API on Edge.js inside a Wasmer sandbox.
// DEPS=sandbox (default): `pnpm install` runs inside the guest over host networking.
// DEPS=host: node_modules installed on the host (scripts disabled) is copied into the guest.
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newWasmer, PKG, reservePort, waitForLine, drain, readTree, bytes, now, ms } from "./lib.mjs";

const mode = process.env.DEPS ?? "sandbox";
const app = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "express-api");
const port = await reservePort();
const t0 = now();
const wasmer = newWasmer();

let files;
if (mode === "host") {
  execSync("npm install --ignore-scripts --no-audit --no-fund --silent", { cwd: app, stdio: "inherit" });
  files = await readTree(app);
} else files = await readTree(app, { skip: ["node_modules", "package-lock.json"] });
console.log(`files: ${Object.keys(files).length} (${(bytes(files) / 1024).toFixed(0)} KiB) [${mode}]`);

let t = now();
const sb = await wasmer.sandboxes.create({ packages: [PKG.edge], files, env: { PORT: String(port) }, network: { mode: "host" } });
console.log(`sandbox create: ${ms(t)}`);
try {
  if (mode !== "host") {
    t = now();
    const out = await sb.command("pnpm", ["install", "--ignore-scripts", "--reporter=append-only"], { cwd: "/workspace" }).run({ check: false });
    console.log(`pnpm install in guest: ${ms(t)} exit=${out.exitCode}`);
    if (!out.ok) { console.log(out.stdout.text().slice(-2000), out.stderr.text().slice(-2000)); process.exitCode = 1; }
  }
  t = now();
  const proc = await sb.command("edge", ["/workspace/server.js"], { cwd: "/workspace" }).spawn({ stdout: "pipe", stderr: "pipe" });
  drain(proc.stderr.lines(), "stderr");
  await waitForLine(proc.stdout.lines(), "listening on", 60_000, "app");
  console.log(`server ready: ${ms(t)}`);
  for (const label of ["first", "warm"]) {
    t = now();
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { connection: "close" } });
    console.log(`GET /api/health (${label}) -> ${r.status} ${await r.text()} ${ms(t)}`);
  }
  console.log(`RESULT a-express[${mode}] PASS total ${ms(t0)}`);
  await proc.terminate({ gracePeriodMs: 1000 });
} catch (e) {
  console.log(`RESULT a-express[${mode}] FAIL ${e.message}`);
  process.exitCode = 1;
} finally {
  await sb.close();
  await wasmer.close();
}
