// Streaming parser for the generator's file protocol. Tags can be split across any chunk boundary.
//
//   Narration text, then:
//   <file path="server.js">
//   ...full file content...
//   </file>
//   <delete path="old.js" />
//   <memory kind="decision" scope="project" title="Short title">Why it matters</memory>

import { validatePath } from "../workspace";

export type ParseEvent =
  | { type: "text"; text: string }
  | { type: "file-start"; path: string }
  | { type: "file-delta"; path: string; bytes: number }
  | { type: "file-end"; path: string; content: string }
  | { type: "delete"; path: string }
  | { type: "memory"; kind: MemoryKind; scope: "project" | "user"; title: string; body: string }
  | { type: "invalid"; path: string; reason: string };

export const MEMORY_KINDS = ["fact", "decision", "workflow", "mistake", "preference", "invariant"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
const MEMORY_OPEN = /<memory\s+([^>]*)>/;
const MEMORY_CLOSE = "</memory>";
const MAX_MEMORY = 2000;

const OPEN = /<file\s+path="([^"]*)"\s*>/;
const DELETE = /<delete\s+path="([^"]*)"\s*\/?>/;
const CLOSE = "</file>";
const MAX_TAG = 260; // longest open/delete tag we wait for before treating "<" as plain text

/** Strip a markdown fence the model sometimes wraps around file content. */
export function stripFence(content: string): string {
  const m = content.match(/^\s*```[\w.+-]*\r?\n([\s\S]*?)\r?\n?```\s*$/);
  return m ? m[1].replace(/\n?$/, "\n") : content;
}

export class FileStreamParser {
  private buffer = "";
  private inFile: { path: string | null; content: string; skipNewline: boolean } | null = null;
  private inMemory: { attrs: string; content: string } | null = null;

  feed(chunk: string): ParseEvent[] {
    this.buffer += chunk;
    const events: ParseEvent[] = [];
    for (;;) {
      if (this.inMemory) {
        const close = this.buffer.indexOf(MEMORY_CLOSE);
        if (close === -1) {
          const safe = Math.max(0, this.buffer.length - (MEMORY_CLOSE.length - 1));
          this.inMemory.content += this.buffer.slice(0, safe);
          this.buffer = this.buffer.slice(safe);
          return events;
        }
        this.inMemory.content += this.buffer.slice(0, close);
        this.buffer = this.buffer.slice(close + MEMORY_CLOSE.length);
        const memory = parseMemory(this.inMemory.attrs, this.inMemory.content);
        this.inMemory = null;
        if (memory) events.push(memory);
        continue;
      }
      if (this.inFile) {
        if (this.inFile.skipNewline && this.buffer.length) {
          if (this.buffer.startsWith("\r\n")) this.buffer = this.buffer.slice(2);
          else if (this.buffer.startsWith("\n")) this.buffer = this.buffer.slice(1);
          this.inFile.skipNewline = false;
        }
        const close = this.buffer.indexOf(CLOSE);
        if (close === -1) {
          // Keep a tail that could be the start of "</file>".
          const safe = Math.max(0, this.buffer.length - (CLOSE.length - 1));
          if (safe > 0) this.appendContent(this.buffer.slice(0, safe), events);
          this.buffer = this.buffer.slice(safe);
          return events;
        }
        this.appendContent(this.buffer.slice(0, close), events);
        this.buffer = this.buffer.slice(close + CLOSE.length);
        this.finishFile(events);
        continue;
      }

      const lt = this.buffer.indexOf("<");
      if (lt === -1) {
        this.emitText(this.buffer, events);
        this.buffer = "";
        return events;
      }
      if (lt > 0) {
        this.emitText(this.buffer.slice(0, lt), events);
        this.buffer = this.buffer.slice(lt);
      }
      const mem = this.buffer.match(MEMORY_OPEN);
      if (mem && mem.index === 0) {
        this.buffer = this.buffer.slice(mem[0].length);
        this.inMemory = { attrs: mem[1], content: "" };
        continue;
      }
      const open = this.buffer.match(OPEN);
      const del = this.buffer.match(DELETE);
      const first = [open, del].filter((m): m is RegExpMatchArray => !!m && m.index === 0)[0];
      if (first === open && open) {
        this.buffer = this.buffer.slice(open[0].length);
        this.startFile(open[1], events);
        continue;
      }
      if (first === del && del) {
        this.buffer = this.buffer.slice(del[0].length);
        const checked = validatePath(del[1]);
        events.push(checked.ok ? { type: "delete", path: checked.path } : { type: "invalid", path: del[1], reason: checked.reason });
        continue;
      }
      // A "<" that may still become a tag: wait for more input, unless it clearly cannot.
      const b = this.buffer;
      const partialKeyword = "<file ".startsWith(b) || "<delete ".startsWith(b) || "<memory ".startsWith(b);
      const unfinishedTag = /^<(file|delete|memory)\s/.test(b) && !b.includes(">");
      if ((partialKeyword || unfinishedTag) && b.length < MAX_TAG) return events;
      this.emitText("<", events);
      this.buffer = this.buffer.slice(1);
    }
  }

  /** Flush at the end of the stream. An unclosed file is reported, never written. */
  end(): ParseEvent[] {
    const events: ParseEvent[] = [];
    this.inMemory = null; // a cut-off memory is dropped
    if (this.inFile) {
      if (this.inFile.path) events.push({ type: "invalid", path: this.inFile.path, reason: "file was cut off before </file>" });
      this.inFile = null;
    } else if (this.buffer) {
      this.emitText(this.buffer, events);
    }
    this.buffer = "";
    return events;
  }

  private startFile(raw: string, events: ParseEvent[]) {
    const checked = validatePath(raw);
    if (checked.ok) {
      this.inFile = { path: checked.path, content: "", skipNewline: true };
      events.push({ type: "file-start", path: checked.path });
    } else {
      this.inFile = { path: null, content: "", skipNewline: true };
      events.push({ type: "invalid", path: raw, reason: checked.reason });
    }
  }

  private appendContent(text: string, events: ParseEvent[]) {
    if (!this.inFile || !text) return;
    this.inFile.content += text;
    if (this.inFile.path) events.push({ type: "file-delta", path: this.inFile.path, bytes: Buffer.byteLength(this.inFile.content, "utf8") });
  }

  private finishFile(events: ParseEvent[]) {
    const file = this.inFile!;
    this.inFile = null;
    if (!file.path) return;
    let content = stripFence(file.content);
    if (!content.endsWith("\n")) content += "\n";
    events.push({ type: "file-end", path: file.path, content });
  }

  private emitText(text: string, events: ParseEvent[]) {
    if (!text) return;
    const last = events[events.length - 1];
    if (last?.type === "text") last.text += text;
    else events.push({ type: "text", text });
  }
}

/** A memory block becomes an event only with a known kind, a title and a body; anything else is dropped. */
function parseMemory(attrs: string, content: string): ParseEvent | null {
  const a = Object.fromEntries([...attrs.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2].trim()]));
  const kind = MEMORY_KINDS.find((k) => k === a.kind);
  const title = (a.title ?? "").slice(0, 160);
  const body = content.trim().slice(0, MAX_MEMORY);
  if (!kind || !title || !body) return null;
  return { type: "memory", kind, scope: a.scope === "user" ? "user" : "project", title, body };
}
