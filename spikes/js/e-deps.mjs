// Spike (e): dependency speed. Express + pg (fixtures/express-pg), measured to "server imports its deps".
//  host:  node_modules installed on the host with scripts disabled, then copied into the guest via `files`
//         (@wasmer/sdk 0.19.1 on Node has no host mounts, so "mounted read-only" is not available).
//  guest: `pnpm install --ignore-scripts` inside the sandbox over host networking (in-memory fs, no cache).
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newWasmer, PKG, readTree, bytes, now, ms } from "./lib.mjs";

const app = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "express-pg");
// A file, not `edge -e`: dynamic import() from eval code resolves through the host loader (see findings).
const check = { "/workspace/check.mjs": "import \"express\"; import \"pg\"; console.log(\"deps ok\");" };

async function trial(mode, run) {
  const t0 = now();
  let files;
  if (mode === "host") {
    if (run === 1) rmSync(path.join(app, "node_modules"), { recursive: true, force: true });
    execSync("npm install --ignore-scripts --no-audit --no-fund --silent", { cwd: app });
    files = { ...(await readTree(app, { skip: ["package-lock.json"] })), ...check };
  } else files = { ...(await readTree(app, { skip: ["node_modules", "package-lock.json"] })), ...check };
  const tPrep = ms(t0);
  const wasmer = newWasmer();
  try {
    const sb = await wasmer.sandboxes.create({ packages: [PKG.edge], files, network: { mode: "host" } });
    if (mode === "guest") await sb.command("pnpm", ["install", "--ignore-scripts"], { cwd: "/workspace" }).run();
    const out = await sb.command("edge", ["/workspace/check.mjs"], { cwd: "/workspace" }).run();
    console.log(`${mode} run ${run}: ${ms(t0)} total (host prep ${tPrep}, ${Object.keys(files).length} files / ${(bytes(files) / 1048576).toFixed(1)} MiB) ${out.text().trim()}`);
    await sb.close();
  } finally {
    await wasmer.close();
  }
}

for (const mode of ["host", "guest"]) for (const run of [1, 2]) await trial(mode, run);
console.log("RESULT e-deps PASS");
