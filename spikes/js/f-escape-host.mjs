// Run by f-permission.mjs as the sandbox host process (with or without Node's permission model).
// Starts an Edge.js sandbox and runs guest code that escapes to the host `process`, then tries
// host reads, writes, child processes, workers and env. Reports only booleans/sizes, never file contents.
import { Wasmer } from "@wasmer/sdk/node";

const [cacheDir, credentials, outside, home, tcpPort] = process.argv.slice(2);
const probe = `
const p = new Function("return process")();
const r = {};
const t = (k, f) => { try { r[k] = f(); } catch (e) { r[k] = "BLOCKED " + String(e.code || e.message).slice(0, 60); } };
t("hostPid", () => p.pid);
t("hostPlatform", () => p.platform);
t("permissionModel", () => Boolean(p.permission));
t("hostEnvKeys", () => Object.keys(p.env).sort().join(","));
t("readCredentials", () => p.getBuiltinModule("fs").readFileSync(${JSON.stringify(credentials)}).length + " bytes readable");
t("listHome", () => p.getBuiltinModule("fs").readdirSync(${JSON.stringify(home)}).length + " entries");
t("writeOutside", () => { p.getBuiltinModule("fs").writeFileSync(${JSON.stringify(outside)}, "escape"); return "WROTE"; });
t("childProcess", () => p.getBuiltinModule("child_process").execFileSync("cmd.exe", ["/c", "echo", "ran"]).toString().trim());
t("worker", () => { new (p.getBuiltinModule("worker_threads").Worker)("1", { eval: true }).terminate(); return "spawned"; });
t("addon", () => { p.dlopen({ exports: {} }, "C:/Windows/System32/kernel32.dll"); return "loaded"; });
t("processBinding", () => typeof p.binding("fs").open);
t("signalParent", () => p.kill(p.ppid, 0) ? "parent signalable" : "no");
t("inspector", () => { const i = p.getBuiltinModule("inspector"); i.open(0); const u = i.url(); i.close(); return u ? "opened" : "no url"; });
const net = p.getBuiltinModule("net");
const s = net.connect(${Number(tcpPort)}, "127.0.0.1");
s.on("connect", () => { r.hostTcpConnect = "connected to host listener"; s.destroy(); console.log(JSON.stringify(r)); });
s.on("error", (e) => { r.hostTcpConnect = "BLOCKED " + e.code; console.log(JSON.stringify(r)); });
`;
const wasmer = new Wasmer({ cache: { directory: cacheDir, readOnly: process.env.CACHE_READONLY === "1" } });
try {
  const sb = await wasmer.sandboxes.create({ packages: ["wasmer/edgejs@0.2.5"] });
  const out = await sb.command("edge", ["-e", probe]).run({ check: false, timeoutMs: 60_000 });
  console.log(out.stdout.text().trim() || `guest failed: ${out.stderr.text().slice(0, 500)}`);
  await sb.close();
} catch (e) {
  console.log(`host failed: ${e.code ?? ""} ${e.message.slice(0, 300)}`);
} finally {
  await wasmer.close().catch(() => {});
}
