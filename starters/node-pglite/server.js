// Adorable starter: Express + PostgreSQL, running on Edge.js with wasmer/pglite in a Wasmer sandbox.
// Adorable sets PORT, HOST and DATABASE_URL. Keep HOST: listeners bind the same address on the host.
import express from "express";
import pg from "pg";

// wasmer/pglite serves exactly one connection per process, so use one long-lived Client (never a Pool).
// The database is fresh on every restart: create the schema idempotently here.
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
await db.query(`CREATE TABLE IF NOT EXISTS todos (
  id serial PRIMARY KEY,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  done boolean NOT NULL DEFAULT false
)`);

const app = express();
app.use(express.json());
app.use(express.static("public"));

app.get("/api/health", async (_req, res) => {
  const { rows } = await db.query("SELECT version()");
  res.json({ ok: true, runtime: `${process.version} ${process.platform}/${process.arch}`, database: rows[0].version });
});

app.get("/api/todos", async (_req, res) => {
  res.json((await db.query("SELECT id, title, done FROM todos ORDER BY id")).rows);
});

app.post("/api/todos", async (req, res) => {
  const title = String(req.body?.title ?? "").trim();
  if (!title || title.length > 200) return res.status(400).json({ error: "title must be 1-200 characters" });
  const { rows } = await db.query("INSERT INTO todos (title) VALUES ($1) RETURNING id, title, done", [title]);
  res.status(201).json(rows[0]);
});

app.patch("/api/todos/:id", async (req, res) => {
  const { rows } = await db.query("UPDATE todos SET done = $2 WHERE id = $1 RETURNING id, title, done", [Number(req.params.id), Boolean(req.body?.done)]);
  return rows[0] ? res.json(rows[0]) : res.status(404).json({ error: "not found" });
});

app.delete("/api/todos/:id", async (req, res) => {
  const { rowCount } = await db.query("DELETE FROM todos WHERE id = $1", [Number(req.params.id)]);
  res.status(rowCount ? 204 : 404).end();
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, process.env.HOST ?? "127.0.0.1", () => console.log(`listening on ${port}`));
