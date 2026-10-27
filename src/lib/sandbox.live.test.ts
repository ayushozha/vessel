// Live sandbox test: boots the certified starters in real Wasmer sandboxes through the pool.
// Opt-in (downloads Wasmer packages, needs network for the guest's pnpm install):
//   $env:VESSEL_LIVE_SANDBOX = "1"; pnpm vitest run src/lib/sandbox.live.test.ts
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { databasePool } from "./database";
import { SandboxPool, type ProjectSandbox } from "./sandbox";

const live = process.env.VESSEL_LIVE_SANDBOX === "1";
const PG_ID = "11111111-1111-4111-8111-111111111111";
const MCP_ID = "22222222-2222-4222-8222-222222222222";

let home: string;
const pool = new SandboxPool();

async function seed(id: string, starter: string) {
  await fs.cp(path.join(process.cwd(), "starters", starter), path.join(home, "projects", id, "workspace"), { recursive: true });
}

const call = async (sb: ProjectSandbox, p: string, init?: RequestInit) => {
  const res = await fetch(new URL(p, sb.appUrl), { ...init, headers: { "content-type": "application/json", connection: "close", ...init?.headers } });
  return { status: res.status, body: await res.text() };
};

describe.skipIf(!live)("live sandbox (VESSEL_LIVE_SANDBOX=1)", () => {
  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "vessel-live-"));
    process.env.VESSEL_HOME = home;
    // Share the real package cache so runs do not re-download Wasmer packages.
    const cache = path.join(os.homedir(), ".config", "vessel", ".wasmer");
    await fs.mkdir(cache, { recursive: true });
    await fs.symlink(cache, path.join(home, ".wasmer"), "junction");
    await seed(PG_ID, "node-pglite");
    await seed(MCP_ID, "node-mcp");
    // The MCP starter boots from the shared deps cache (no guest install); the pglite one installs in the guest.
    const { warm } = await import("../../scripts/warm-deps.mjs");
    await warm(path.join(process.cwd(), "starters", "node-mcp"), path.join(home, "deps"));
  }, 120_000);

  afterAll(async () => {
    await pool.stopAll();
    await databasePool().stopAll();
    delete process.env.VESSEL_HOME;
    await fs.rm(home, { recursive: true, force: true });
  });

  it("runs the Express + pglite starter: CRUD, restart, reset", async () => {
    const sb = await pool.start(PG_ID, "node-pglite");
    expect(sb.state).toBe("running");
    expect(sb.logs.some((l) => l.source === "install")).toBe(true);
    const health = await call(sb, "/api/health");
    expect(health.status).toBe(200);
    expect(health.body).toContain("wasi/wasm32");
    expect(health.body).toContain("PostgreSQL");
    expect((await call(sb, "/")).body).toContain("<h1>Todos</h1>");

    expect((await call(sb, "/api/todos", { method: "POST", body: JSON.stringify({ title: "ship" }) })).status).toBe(201);
    expect(JSON.parse((await call(sb, "/api/todos")).body)).toEqual([{ id: 1, title: "ship", done: false }]);
    expect((await call(sb, "/api/todos", { method: "POST", body: "{}" })).status).toBe(400);

    await sb.syncFiles({ "public/hello.txt": "synced" });
    expect((await call(sb, "/hello.txt")).body).toBe("synced");

    await sb.restart();
    expect(sb.state).toBe("running");
    expect((await call(sb, "/api/health")).status).toBe(200);

    // Data lives in the persistent PGlite host, so it survives an app restart.
    expect(JSON.parse((await call(sb, "/api/todos")).body)).toEqual([{ id: 1, title: "ship", done: false }]);

    const fresh = await pool.resetData(PG_ID);
    expect(JSON.parse((await call(fresh, "/api/todos")).body)).toEqual([]);
    expect(fresh.logs.some((l) => l.source === "app" && l.line.includes("listening on"))).toBe(true);
  }, 300_000);

  it("runs the MCP starter: initialize, list and call tools", async () => {
    const sb = await pool.start(MCP_ID, "node");
    expect(sb.logs.some((l) => l.source === "install")).toBe(false);
    const rpc = (method: string, params: object) =>
      call(sb, "/mcp", {
        method: "POST",
        headers: { accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vessel-live-test", version: "0" } });
    expect(init.status).toBe(200);
    expect(init.body).toContain("vessel-starter");
    expect((await rpc("tools/list", {})).body).toContain('"add"');
    expect((await rpc("tools/call", { name: "add", arguments: { a: 2, b: 40 } })).body).toContain('"text":"42"');
    expect((await rpc("tools/call", { name: "runtime", arguments: {} })).body).toContain("wasi/wasm32");
  }, 300_000);
});
