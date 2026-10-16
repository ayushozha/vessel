// Run a host-compiled WASI/WASIX module inside a Wasmer sandbox.
//   node lib/run-wasm.mjs <file.wasm>           -> run once, print stdout
//   node lib/run-wasm.mjs <file.wasm> --serve   -> spawn with PORT, fetch / from the host
//   node lib/run-wasm.mjs <file.wasm> --serve {PORT}  -> also pass the port as argv[1]
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { relative } from "node:path";
import { wasmer, root, timed, freePort, fetchWhenReady, pipeLines } from "./harness.mjs";
import { concurrencyProbe } from "./concurrency.mjs";

export async function runWasm(file, { serve = false, net = serve, args = [], path = "/" } = {}) {
  const bytes = await readFile(file);
  const pkg = await timed(`load ${relative(root, file).replaceAll("\\", "/")}`, () => wasmer.packages.load(bytes));
  const sandbox = await timed("sandbox", () =>
    wasmer.sandboxes.create({ packages: [pkg], network: net ? { mode: "host" } : { mode: "disabled" } }),
  );
  try {
    if (!serve) {
      const out = await timed("run", () => sandbox.command(pkg, args).run({ check: false }));
      console.log(`exit=${out.exitCode}\n${out.stdout.text()}${out.stderr.text()}`);
      return out;
    }
    const port = await freePort();
    const t0 = performance.now();
    // PORT goes in env, and replaces a literal {PORT} argument for runtimes without env access.
    const argv = args.map((a) => (a === "{PORT}" ? String(port) : a));
    const proc = await sandbox.command(pkg, argv, { env: { PORT: String(port) } }).spawn({ stdout: "pipe", stderr: "pipe" });
    pipeLines(proc.stdout, "[guest]");
    pipeLines(proc.stderr, "[guest:err]");
    try {
      const first = await fetchWhenReady(`http://127.0.0.1:${port}${path}`, { proc });
      console.log(`[time] start->first response: ${Math.round(performance.now() - t0)} ms`, first);
      const warm = await timed("warm request", () => fetchWhenReady(`http://127.0.0.1:${port}${path}`));
      console.log(warm);
      console.log("[concurrency] idle client + 20 parallel requests:", await concurrencyProbe(port));
      return first;
    } finally {
      await proc.kill().catch(() => {});
    }
  } finally {
    await sandbox.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, ...rest] = process.argv.slice(2);
  try {
    const flags = new Set(rest.filter((a) => a.startsWith("--")));
    await runWasm(file, { serve: flags.has("--serve"), net: flags.has("--serve") || flags.has("--net"), args: rest.filter((a) => !a.startsWith("--")) });
  } finally {
    await wasmer.close();
  }
}
