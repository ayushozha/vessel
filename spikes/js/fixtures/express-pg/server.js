import express from "express";
import pg from "pg";

// wasmer/pglite serves exactly one connection per process: use one long-lived Client, never a Pool.
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
await db.query("CREATE TABLE IF NOT EXISTS todos (id serial PRIMARY KEY, title text NOT NULL, done boolean NOT NULL DEFAULT false)");

const app = express();
app.use(express.json());
app.get("/api/todos", async (_req, res) => res.json((await db.query("SELECT * FROM todos ORDER BY id")).rows));
app.post("/api/todos", async (req, res) => {
  const { rows } = await db.query("INSERT INTO todos (title) VALUES ($1) RETURNING *", [String(req.body?.title ?? "untitled")]);
  res.status(201).json(rows[0]);
});
app.get("/api/version", async (_req, res) => res.json((await db.query("SELECT version()")).rows[0]));

const port = Number(process.env.PORT ?? 3000);
app.listen(port, process.env.HOST ?? "127.0.0.1", () => console.log(`listening on ${port}`));
