// Per-project PostgreSQL host. Forked by src/lib/database.ts as a plain Node child with a scrubbed environment
// (no permission model: PGlite needs process.binding). It runs only Adorable's code: PGlite (Postgres compiled to
// WebAssembly) with an on-disk data directory, so app data survives restarts, and serves it over TCP so the
// app in its Wasmer sandbox connects with an ordinary Postgres client.
// Protocol (process IPC): parent sends { id, op, ...args }; child replies { id, ok, error?, port? }.
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

/** @type {PGlite | null} */
let db = null;
/** @type {PGLiteSocketServer | null} */
let server = null;

const ops = {
  async start({ dataDir }) {
    db = await PGlite.create(dataDir);
    server = new PGLiteSocketServer({ db, port: 0, host: "127.0.0.1" });
    await server.start();
    const port = server.server?.address?.()?.port ?? server.port;
    if (!port) throw new Error("database server did not report a port");
    return { port };
  },
  async stop() {
    await server?.stop().catch(() => {});
    await db?.close().catch(() => {});
    setImmediate(() => process.exit(0));
    return {};
  },
};

process.on("message", async (message) => {
  try {
    const op = ops[message.op];
    if (!op) throw new Error(`unknown op ${message.op}`);
    process.send?.({ id: message.id, ok: true, ...(await op(message)) });
  } catch (error) {
    process.send?.({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
// Exit with the Adorable server: a closed IPC channel means the parent is gone.
process.on("disconnect", () => process.exit(0));
