// Spike (d): Next.js `next build` and `next dev` on Edge.js inside a Wasmer sandbox.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newWasmer, PKG, reservePort, waitForLine, drain, readTree, now, ms } from "./lib.mjs";

const app = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "next-app");
const t0 = now();
const wasmer = newWasmer();
const sb = await wasmer.sandboxes.create({
  packages: [PKG.edge],
  files: await readTree(app, { skip: ["node_modules", ".next"] }),
  // HOME: os.homedir() throws ENOENT without it. WATCHPACK_POLLING: fs.watch is ENOSYS in WASIX.
  env: { NEXT_TELEMETRY_DISABLED: "1", HOME: "/workspace", WATCHPACK_POLLING: "true" },
  network: { mode: "host" },
});
const results = {};
const firstError = (out) => (out.stderr.text() + out.stdout.text()).split("\n").find((l) => /error|Error|failed/.test(l))?.trim().slice(0, 300) ?? `exit ${out.exitCode}`;
try {
  let t = now();
  const install = await sb.command("pnpm", ["install", "--ignore-scripts", "--reporter=append-only"], { cwd: "/workspace" }).run({ check: false, timeoutMs: 600_000 });
  console.log(`pnpm install (guest): ${ms(t)} exit=${install.exitCode}`);
  if (!install.ok) throw new Error(`install: ${firstError(install)}`);
  // SKIP_BUILD=1 runs only `next dev` (`next build --webpack` hung on this machine; see findings).
  if (!process.env.SKIP_BUILD) {
  t = now();
  const build = await sb.command("edge", ["node_modules/next/dist/bin/next", "build", "--webpack"], { cwd: "/workspace" }).run({ check: false, timeoutMs: 600_000 });
  console.log(`next build: ${ms(t)} exit=${build.exitCode}\n${build.stdout.text().slice(-1500)}\n${build.stderr.text().slice(-1500)}`);
  results.build = build.ok ? "PASS" : `FAIL ${firstError(build)}`;
  }
  const port = await reservePort();
  t = now();
  const dev = await sb.command("edge", ["node_modules/next/dist/bin/next", "dev", "--webpack", "-H", "127.0.0.1", "-p", String(port)], { cwd: "/workspace" }).spawn({ stdout: "pipe", stderr: "pipe" });
  const errs = drain(dev.stderr.lines(), "dev-err");
  try {
    await waitForLine(dev.stdout.lines(), "Ready", 180_000, "dev");
    const t1 = now();
    const r = await fetch(`http://127.0.0.1:${port}/`, { headers: { connection: "close" } });
    const html = await r.text();
    console.log(`dev GET / -> ${r.status} ${ms(t1)} (ready ${ms(t)})`);
    results.dev = r.ok && html.includes("inside a Wasmer sandbox") ? "PASS" : `FAIL ${r.status} ${html.slice(0, 200)}`;
  } catch (e) {
    results.dev = `FAIL ${e.message} ${errs.slice(-3).join(" | ").slice(0, 300)}`;
  } finally {
    await dev.terminate({ gracePeriodMs: 500 }).catch(() => {});
  }
} catch (e) {
  results.error = e.message;
  process.exitCode = 1;
} finally {
  console.log(`RESULT d-next ${JSON.stringify(results)} total ${ms(t0)}`);
  await sb.close().catch(() => {});
  await wasmer.close().catch((e) => console.log(`wasmer.close: ${e.code ?? e.message}`));
}
