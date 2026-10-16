// Node 24 keeps WebAssembly JSPI behind a flag that NODE_OPTIONS rejects; the SDK needs it.
import v8 from "node:v8";
v8.setFlagsFromString("--experimental-wasm-jspi");
// Shared helpers for the JS runtime spikes. Run from the repo root: node spikes/js/<spike>.mjs
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Wasmer } from "@wasmer/sdk/node";

export const CACHE_DIR = path.join(os.homedir(), ".config", "vessel", ".wasmer");
export const PKG = {
  edge: "wasmer/edgejs@0.2.5",
  pglite: "wasmer/pglite@0.2.0",
  sws: "wasmer/static-web-server@2.44.0",
};

export const newWasmer = () => new Wasmer({ cache: { directory: CACHE_DIR }, outputBytes: 1024 * 1024 });

export const now = () => performance.now();
export const ms = (t0) => `${Math.round(performance.now() - t0)}ms`;

export async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Resolve when a line containing `marker` appears; echo lines with `tag`. */
export async function waitForLine(lines, marker, timeoutMs, tag = "") {
  let timer;
  try {
    return await Promise.race([
      (async () => {
        for await (const line of lines) {
          if (tag) console.log(`[${tag}] ${line}`);
          if (line.includes(marker)) return line;
        }
        throw new Error(`process exited before emitting ${marker}`);
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out waiting for ${marker}`)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Keep draining a stream in the background, echoing with a tag. */
export function drain(lines, tag, sink = []) {
  (async () => { for await (const line of lines) { sink.push(line); if (tag) console.log(`[${tag}] ${line}`); } })().catch(() => {});
  return sink;
}

/** Poll an HTTP URL until it answers (any status). */
export async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { const r = await fetch(url, { headers: { connection: "close" } }); return r; } catch (e) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${url}: ${e.cause?.code ?? e.message}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

/** Read a host directory into a `files` map rooted at the guest's /workspace (skips `skip` names). */
export async function readTree(root, { skip = [] } = {}) {
  const { readdir, readFile } = await import("node:fs/promises");
  const files = {};
  async function walk(dir, rel) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (skip.includes(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(abs, r);
      else if (entry.isFile()) files[`/workspace/${r}`] = await readFile(abs);
    }
  }
  await walk(root, "");
  return files;
}

export const bytes = (files) => Object.values(files).reduce((n, b) => n + b.length, 0);
