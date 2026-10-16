// C / C++ spike: compile INSIDE a Wasmer sandbox with clang/clang, then run the
// output in the same sandbox. Servers are fetched from the host on a random port.
//   node c/spike.mjs               hello + HTTP for C and C++
//   node c/spike.mjs --stl-repro   reproduce the libc++ <atomic> compile hang
//   node c/spike.mjs --depth-repro reproduce the clang frontend crash on nested code
import { readFileSync } from "node:fs";
import { wasmer, root, timed, freePort, fetchWhenReady, pipeLines } from "../lib/harness.mjs";
import { concurrencyProbe } from "../lib/concurrency.mjs";

const CLANG = "clang/clang@=0.160000.1";
const sources = {
  "hello.c": "c/src/hello.c",
  "hello.cpp": "c/src/hello.cpp",
  "stl-repro.cpp": "c/src/stl-repro.cpp",
  "depth-repro.c": "c/src/depth-repro.c",
  "server.c": "starters/c/server.c",
  "server.cpp": "starters/cpp/server.cpp",
};
const files = Object.fromEntries(Object.entries(sources).map(([name, path]) => [name, readFileSync(root + path, "utf8")]));
const cpp = ["--driver-mode=g++", "-fno-exceptions"];

const sandbox = await timed("create sandbox (+clang package, cold if not cached)", () =>
  wasmer.sandboxes.create({ packages: [CLANG], files, network: { mode: "host" } }),
);

async function compile(file, flags = [], { timeoutMs = 120_000 } = {}) {
  const out = `/workspace/${file.replace(/\.\w+$/, "")}-${file.endsWith(".cpp") ? "cpp" : "c"}.wasm`;
  const proc = await sandbox.command("clang", [...flags, "-O2", `/workspace/${file}`, "-o", out]).spawn({ stdout: "capture", stderr: "capture" });
  // RunOptions.timeoutMs was not enforced for this hang in 0.19.1, so race a host-side timer.
  const timer = new Promise((r) => setTimeout(() => r(null), timeoutMs));
  const result = await Promise.race([proc.wait(), timer]);
  if (!result) {
    await proc.kill().catch(() => {});
    throw new Error(`clang did not finish within ${timeoutMs} ms for ${file}`);
  }
  if (result.exitCode !== 0) throw new Error(`clang failed for ${file}:\n${result.stderr.text()}`);
  return sandbox.installPackage(await sandbox.fs.readFile(out));
}

async function hello(file, flags) {
  const pkg = await timed(`compile ${file}`, () => compile(file, flags));
  console.log((await timed(`run ${file}`, () => sandbox.command(pkg).run())).text().trim());
}

async function server(file, flags) {
  await timed(`compile ${file} (warm clang)`, () => compile(file, flags));
  const pkg = await timed(`compile ${file} again`, () => compile(file, flags));
  const port = await freePort();
  const t0 = performance.now();
  const proc = await sandbox.command(pkg, { env: { PORT: String(port) } }).spawn({ stdout: "pipe", stderr: "pipe" });
  pipeLines(proc.stdout, "[guest]");
  pipeLines(proc.stderr, "[guest:err]");
  const first = await fetchWhenReady(`http://127.0.0.1:${port}/`, { proc });
  console.log(`[time] ${file} start->first response: ${Math.round(performance.now() - t0)} ms`, first);
  console.log(await timed("warm request", () => fetchWhenReady(`http://127.0.0.1:${port}/`)));
  console.log("[concurrency] idle client + 20 parallel requests:", await concurrencyProbe(port));
  await proc.kill();
}

try {
  if (process.argv.includes("--stl-repro")) {
    await timed("compile stl-repro.cpp", () => compile("stl-repro.cpp", cpp, { timeoutMs: 60_000 }));
  } else if (process.argv.includes("--depth-repro")) {
    await timed("compile depth-repro.c", () => compile("depth-repro.c"));
  } else {
    await hello("hello.c");
    await server("server.c");
    await hello("hello.cpp", cpp);
    await server("server.cpp", cpp);
  }
} finally {
  await sandbox.close();
  await wasmer.close();
}
