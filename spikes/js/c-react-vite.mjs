// Spike (c): React + Vite inside a Wasmer sandbox: pnpm install, `vite build`, serve dist, `vite dev`.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newWasmer, PKG, reservePort, waitForLine, waitForHttp, drain, readTree, now, ms } from "./lib.mjs";

const app = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", `react-vite${process.env.VITE ?? "7"}`);
const step = process.env.STEPS?.split(",") ?? ["build", "serve", "dev"];
const t0 = now();
const wasmer = newWasmer();
const sb = await wasmer.sandboxes.create({
  packages: [PKG.edge, PKG.sws],
  files: await readTree(app, { skip: ["node_modules", "dist", "package-lock.json"] }),
  network: { mode: "host" },
});
const results = {};
const run = async (label, cmd, args, timeoutMs = 300_000) => {
  const t = now();
  const out = await sb.command(cmd, args, { cwd: "/workspace" }).run({ check: false, timeoutMs });
  console.log(`${label}: ${ms(t)} exit=${out.exitCode} ${out.reason}`);
  if (!out.ok) console.log(`--- stdout\n${out.stdout.text().slice(-3000)}\n--- stderr\n${out.stderr.text().slice(-3000)}`);
  return out;
};
try {
  const install = await run("pnpm install (guest)", "pnpm", ["install", "--ignore-scripts", "--reporter=append-only"]);
  if (install.ok && app.endsWith("7")) {
    const bin = await sb.command("bash", ["-c", "cat node_modules/esbuild/bin/esbuild"], { cwd: "/workspace" }).run({ check: false });
    console.log("esbuild-wasm patch applied:", bin.stdout.text().includes("loader._compile"));
  }
  if (!install.ok) throw new Error("install failed");
  // The guest pnpm installs a flat node_modules (no .pnpm store), so list the top level and scopes.
  const ls = await sb.command("bash", ["-c", "ls node_modules node_modules/@rolldown node_modules/@rollup 2>/dev/null"], { cwd: "/workspace" }).run({ check: false });
  console.log("native/wasm bindings installed:", ls.stdout.text().split(/\s+/).filter((n) => /binding|lightningcss|wasm/.test(n)).join(" ") || "(none)");

  if (step.includes("build")) {
    const build = await run("vite build", "edge", ["node_modules/vite/bin/vite.js", "build"]);
    results.build = build.ok ? "PASS" : `FAIL ${build.stderr.text().split("\n").find((l) => /Error|error/.test(l)) ?? build.exitCode}`;
    if (build.ok) console.log(build.stdout.text().slice(-800));
  }
  if (step.includes("serve") && results.build === "PASS") {
    const port = await reservePort();
    const t = now();
    const sws = await sb.command("static-web-server", ["--host", "127.0.0.1", "--port", String(port), "--root", "/workspace/dist", "--page-fallback", "/workspace/dist/index.html"]).spawn({ stdout: "pipe", stderr: "pipe" });
    drain(sws.stdout.lines(), ""); drain(sws.stderr.lines(), "");
    const r = await waitForHttp(`http://127.0.0.1:${port}/`, 30_000);
    const html = await r.text();
    console.log(`static-web-server dist: ${r.status} ${ms(t)} ${html.includes('id="root"') ? "index ok" : html.slice(0, 120)}`);
    results.serve = r.ok && html.includes('id="root"') ? "PASS" : `FAIL ${r.status}`;
    await sws.terminate({ gracePeriodMs: 500 });
  }
  if (step.includes("dev")) {
    const port = await reservePort();
    const t = now();
    const dev = await sb.command("edge", ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: "/workspace" }).spawn({ stdout: "pipe", stderr: "pipe" });
    const errs = drain(dev.stderr.lines(), "dev-err");
    try {
      await waitForLine(dev.stdout.lines(), "Local:", 120_000, "dev");
      console.log(`vite dev ready: ${ms(t)}`);
      for (const p of ["/", "/src/main.jsx", "/src/App.jsx"]) {
        const t1 = now();
        const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers: { connection: "close" } });
        const body = await r.text();
        console.log(`dev GET ${p} -> ${r.status} ${body.length}B ${ms(t1)} ${p.endsWith(".jsx") ? (body.includes("jsx") || body.includes("jsxDEV") ? "(transformed)" : body.slice(0, 120)) : ""}`);
        if (!r.ok) throw new Error(`${p} ${r.status} ${body.slice(0, 300)}`);
      }
      results.dev = "PASS";
    } catch (e) {
      results.dev = `FAIL ${e.message} ${errs.slice(-5).join(" | ")}`;
    } finally {
      await dev.terminate({ gracePeriodMs: 500 });
    }
  }
} catch (e) {
  results.error = e.message;
  process.exitCode = 1;
} finally {
  console.log(`RESULT c-react-vite${process.env.VITE ?? "7"} ${JSON.stringify(results)} total ${ms(t0)}`);
  await sb.close();
  await wasmer.close();
}
