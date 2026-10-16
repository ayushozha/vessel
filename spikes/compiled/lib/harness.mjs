// Shared spike harness: one Wasmer client, timing, free-port pick, HTTP probe.
import { createServer } from "node:net";
import { Wasmer } from "@wasmer/sdk/node";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("..", import.meta.url));
// SPIKE_WASMER_CACHE lets a run start from an empty package cache to measure cold downloads.
export const wasmer = new Wasmer({ cache: { directory: process.env.SPIKE_WASMER_CACHE ?? `${root}.cache/wasmer` } });

export async function timed(label, fn) {
  const t = performance.now();
  const value = await fn();
  const ms = Math.round(performance.now() - t);
  console.log(`[time] ${label}: ${ms} ms`);
  return value;
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer().once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Poll the guest server from the host until it answers or the deadline passes. */
export async function fetchWhenReady(url, { timeoutMs = 30_000, proc } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      return { status: res.status, type: res.headers.get("content-type"), body: await res.text() };
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (proc) await proc.kill().catch(() => {});
  throw new Error(`no HTTP answer from ${url}: ${last?.cause?.code ?? last?.message}`);
}

/** Drain a live stream to the console with a prefix (does not block). */
export function pipeLines(stream, prefix) {
  if (!stream) return;
  (async () => {
    for await (const line of stream.lines()) console.log(`${prefix} ${line}`);
  })().catch(() => {});
}
