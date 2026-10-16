// Pre-install certified starter dependencies into Vessel's shared deps cache so sandboxes boot without a
// guest `pnpm install` (about 2-4s instead of ~11s; see docs/runtime-findings.md). Usage:
//   node scripts/warm-deps.mjs [starters/<name> ...]   (defaults to every starter)
// Install scripts are disabled: npm only downloads and unpacks; no package code runs on the host.
// npm (not pnpm) on purpose: its flat node_modules has no symlinks, which the pool does not copy.
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Must match depsKey in src/lib/sandbox.ts (a unit test checks this). */
export function depsKey(manifest) {
  const sorted = (o = {}) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  const canonical = JSON.stringify({ d: sorted(manifest.dependencies), v: sorted(manifest.devDependencies) });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

export async function warm(starterDir, depsRoot) {
  const manifest = JSON.parse(await fs.readFile(path.join(starterDir, "package.json"), "utf8"));
  const target = path.join(depsRoot, depsKey(manifest));
  const { dependencies, devDependencies, pnpm } = manifest;
  await fs.mkdir(target, { recursive: true });
  // pnpm overrides become npm overrides so the cache resolves the same versions the guest would.
  const pkg = { name: "vessel-deps", private: true, dependencies, devDependencies, overrides: pnpm?.overrides };
  await fs.writeFile(path.join(target, "package.json"), JSON.stringify(pkg, null, 2));
  execSync("npm install --ignore-scripts --no-audit --no-fund --omit=optional", { cwd: target, stdio: "inherit" });
  console.log(`warmed ${path.basename(starterDir)} -> ${target}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const home = process.env.VESSEL_HOME || path.join(os.homedir(), ".config", "vessel");
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dirs = process.argv.slice(2).length
    ? process.argv.slice(2).map((d) => path.resolve(d))
    : (await fs.readdir(path.join(root, "starters"), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => path.join(root, "starters", e.name));
  for (const dir of dirs) await warm(dir, path.join(home, "deps"));
}
