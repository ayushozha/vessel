// Spike (f): does Node's permission model contain the Edge.js escape? Runs f-escape-host.mjs as a child
// process plain, with the allow-list Vessel uses for sandbox hosts, and with single flags dropped.
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const cache = path.join(os.homedir(), ".config", "vessel", ".wasmer");
const credentials = path.join(os.homedir(), ".config", "vessel", "credentials.json");
const outside = path.join(os.tmpdir(), "vessel-escape-canary.txt");
const scrubbed = Object.fromEntries(["SystemRoot", "windir", "TEMP", "TMP", "PATH"].filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
const allow = ["--permission", `--allow-fs-read=${path.join(repo, "node_modules")}`, `--allow-fs-read=${here}`, `--allow-fs-read=${cache}`];

const runs = {
  "no permission model, full env": { flags: [], env: process.env },
  "permission model, scrubbed env, read-only cache": { flags: [...allow, "--allow-worker"], env: { ...scrubbed, CACHE_READONLY: "1" } },
  // Each variant below drops one thing to show whether it is needed.
  "permission model without --allow-worker": { flags: allow, env: { ...scrubbed, CACHE_READONLY: "1" } },
  "permission model, writable cache (no --allow-fs-write)": { flags: [...allow, "--allow-worker"], env: scrubbed },
};

// A host TCP listener stands in for Vessel's own server: can escaped code reach it?
const listener = net.createServer((c) => c.end()).listen(0, "127.0.0.1");
await new Promise((r) => listener.once("listening", r));
const tcpPort = String(listener.address().port);

const run = (args, env) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", () => resolve({ stdout, stderr }));
  });

for (const [label, { flags, env }] of Object.entries(runs)) {
  rmSync(outside, { force: true });
  const r = await run(["--experimental-wasm-jspi", ...flags, path.join(here, "f-escape-host.mjs"), cache, credentials, outside, os.homedir(), tcpPort], env);
  const line = r.stdout.split("\n").find((l) => l.startsWith("{") || l.includes("failed")) ?? r.stderr.slice(0, 600);
  console.log(`\n== ${label}\nflags: ${flags.join(" ") || "(none)"}\n${line}\ncanary written outside: ${existsSync(outside)}`);
}
rmSync(outside, { force: true });
listener.close();
