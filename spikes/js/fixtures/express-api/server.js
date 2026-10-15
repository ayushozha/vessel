import express from "express";
const app = express();
const started = Date.now();
app.get("/api/health", (_req, res) => res.json({ ok: true, runtime: `${process.version} ${process.platform}/${process.arch}`, uptimeMs: Date.now() - started }));
app.get("/api/items", (_req, res) => res.json([{ id: 1, name: "wasm" }, { id: 2, name: "edge" }]));
const port = Number(process.env.PORT ?? 3000);
app.listen(port, "0.0.0.0", () => console.log(`listening on ${port}`));
