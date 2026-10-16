// Concurrency probe: hold one idle TCP client open, then fire N parallel requests.
// A blocking single-threaded server stalls on the idle client; a poller-based one does not.
import { connect } from "node:net";

export async function concurrencyProbe(port, n = 20) {
  const idle = connect(port, "127.0.0.1");
  await new Promise((r) => idle.once("connect", r));
  const t = performance.now();
  const results = await Promise.allSettled(
    Array.from({ length: n }, () => fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5_000) }).then((r) => r.status)),
  );
  idle.destroy();
  const ok = results.filter((r) => r.status === "fulfilled" && r.value === 200).length;
  return { ok, total: n, ms: Math.round(performance.now() - t), idleClientBlocks: ok === 0 };
}
