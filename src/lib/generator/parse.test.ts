import { describe, expect, it } from "vitest";

import { FileStreamParser, stripFence, type ParseEvent } from "./parse";

const OUTPUT = `I'll build a small Express API with a tickets table.

<file path="server.js">
import express from "express";
const app = express();
app.get("/api/x", (req, res) => res.json({ ok: 1 < 2 }));
app.listen(process.env.PORT);
</file>
<file path="public/index.html">
<!doctype html><title>Tickets</title><p>a < b</p>
</file>
<delete path="old.js" />
Done: 2 files.`;

function parseAll(chunks: string[]) {
  const p = new FileStreamParser();
  const events: ParseEvent[] = [];
  for (const c of chunks) events.push(...p.feed(c));
  events.push(...p.end());
  return events;
}

const summarize = (events: ParseEvent[]) => ({
  text: events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join(""),
  files: events.filter((e) => e.type === "file-end").map((e) => [(e as { path: string }).path, (e as { content: string }).content]),
  deletes: events.filter((e) => e.type === "delete").map((e) => (e as { path: string }).path),
  invalid: events.filter((e) => e.type === "invalid"),
});

describe("FileStreamParser", () => {
  const expected = summarize(parseAll([OUTPUT]));

  it("extracts narration, files and deletes", () => {
    expect(expected.text.replace(/\s+/g, " ").trim()).toBe("I'll build a small Express API with a tickets table. Done: 2 files.");
    expect(expected.files).toEqual([
      ["server.js", 'import express from "express";\nconst app = express();\napp.get("/api/x", (req, res) => res.json({ ok: 1 < 2 }));\napp.listen(process.env.PORT);\n'],
      ["public/index.html", "<!doctype html><title>Tickets</title><p>a < b</p>\n"],
    ]);
    expect(expected.deletes).toEqual(["old.js"]);
    expect(expected.invalid).toEqual([]);
  });

  it("gives identical results however the stream is chunked", () => {
    for (let i = 1; i < OUTPUT.length; i++) {
      expect(summarize(parseAll([OUTPUT.slice(0, i), OUTPUT.slice(i)]))).toEqual(expected);
    }
    expect(summarize(parseAll([...OUTPUT]))).toEqual(expected); // one character at a time
  });

  it("reports growing byte counts while a file streams", () => {
    const deltas = parseAll([...OUTPUT]).filter((e) => e.type === "file-delta" && e.path === "server.js") as { bytes: number }[];
    expect(deltas.length).toBeGreaterThan(5);
    expect(deltas.every((d, i) => i === 0 || d.bytes >= deltas[i - 1].bytes)).toBe(true);
  });

  it("rejects unsafe paths without writing them, and keeps parsing", () => {
    const s = summarize(parseAll(['<file path="../etc/passwd">x\n</file><file path=".env">SECRET=1\n</file><file path="ok.js">1\n</file>']));
    expect(s.invalid.map((e) => (e as { path: string }).path)).toEqual(["../etc/passwd", ".env"]);
    expect(s.files).toEqual([["ok.js", "1\n"]]);
  });

  it("never writes a file that was cut off", () => {
    const events = parseAll(['<file path="a.js">partial content']);
    expect(events.some((e) => e.type === "file-end")).toBe(false);
    expect(events).toContainEqual({ type: "invalid", path: "a.js", reason: "file was cut off before </file>" });
  });

  it("treats stray angle brackets in narration as text", () => {
    expect(summarize(parseAll(["Use <b>bold</b> and x<y, then <filed>"])).text).toBe("Use <b>bold</b> and x<y, then <filed>");
  });

  it("strips a markdown fence wrapped around file content", () => {
    expect(summarize(parseAll(['<file path="a.ts">\n```ts\nconst a = 1;\n```\n</file>'])).files).toEqual([["a.ts", "const a = 1;\n"]]);
    expect(stripFence("plain\n")).toBe("plain\n");
  });
});

describe("memory blocks", () => {
  const OUT = 'Done.\n<memory kind="decision" scope="project" title="Soft delete tickets">Keep resolved tickets; never DELETE rows.</memory>\n<memory kind="preference" scope="user" title="Indigo accents">The user likes indigo accents.</memory><memory kind="bogus" title="x">y</memory><memory kind="fact">no title</memory>';

  it("emits valid memories, drops unknown kinds or missing titles, and keeps them out of narration", () => {
    for (const chunks of [[OUT], [...OUT]]) {
      const events = (() => {
        const p = new FileStreamParser();
        return [...chunks.flatMap((c) => p.feed(c)), ...p.end()];
      })();
      const memories = events.filter((e) => e.type === "memory");
      expect(memories).toEqual([
        { type: "memory", kind: "decision", scope: "project", title: "Soft delete tickets", body: "Keep resolved tickets; never DELETE rows." },
        { type: "memory", kind: "preference", scope: "user", title: "Indigo accents", body: "The user likes indigo accents." },
      ]);
      const text = events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("");
      expect(text).not.toContain("memory");
    }
  });

  it("drops a memory that was cut off", () => {
    const p = new FileStreamParser();
    const events = [...p.feed('<memory kind="fact" title="t">partial'), ...p.end()];
    expect(events.some((e) => e.type === "memory")).toBe(false);
  });
});
