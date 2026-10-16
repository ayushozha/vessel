// Install Provena (github.com/ayushozha/provena), the memory engine behind the builder's Memory tab, into
// Vessel's toolchains folder: clone a pinned commit, install the CLI's locked dependencies and build it.
// Usage: pnpm setup:provena   (re-running updates the checkout to the pinned commit)
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = "https://github.com/ayushozha/provena.git";
const COMMIT = process.env.PROVENA_COMMIT || "d24b8ad0bd69b3270d2d98e36974ed6a195ad880";
const home = process.env.VESSEL_HOME || path.join(os.homedir(), ".config", "vessel");
const dir = path.join(home, "toolchains", "provena");
const shell = process.platform === "win32";
const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit", shell });

if (!existsSync(path.join(dir, ".git"))) sh("git", ["clone", "--filter=blob:none", REPO, dir]);
sh("git", ["fetch", "origin"], dir);
sh("git", ["checkout", "--detach", COMMIT], dir);
sh("npm", ["ci", "--no-audit", "--no-fund"], path.join(dir, "cli"));
sh("npm", ["run", "build"], path.join(dir, "cli"));
console.log(`\nProvena is ready: ${path.join(dir, "cli", "dist", "cli.js")}`);
