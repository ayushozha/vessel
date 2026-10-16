// Timed host build steps for the host-compile -> .wasm -> sandbox routes.
import { execFileSync } from "node:child_process";
import { root } from "./harness.mjs";

export function build(label, cmd, args, { cwd = root, env = {} } = {}) {
  const t = performance.now();
  try {
    execFileSync(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] });
  } catch (err) {
    throw new Error(`${label} failed:\n${err.stderr?.toString() ?? err.message}`);
  }
  console.log(`[time] ${label}: ${Math.round(performance.now() - t)} ms`);
}
