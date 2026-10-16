"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ChatMessage } from "@/lib/generator/history";
import type { RunEvent } from "@/lib/generator/run";

export type LiveFile = { path: string; bytes: number; status: "writing" | "written" | "deleted" | "rejected"; reason?: string };
export type LiveRun = { runId?: string; model?: string; stage: "plan" | "generate"; text: string; files: LiveFile[]; startedAt: number };
export type LogLine = { at: number; text: string; tone?: "ok" | "err" | "dim" };

const kb = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

/** Chat history plus a live streaming run for one project. */
export function useRun(projectId: string, brief: string) {
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [live, setLive] = useState<LiveRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileVersion, setFileVersion] = useState(0);
  const [log, setLog] = useState<LogLine[]>([]);
  const [lastRun, setLastRun] = useState<Extract<RunEvent, { type: "run-end" }> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const autostarted = useRef(false);

  const addLog = (text: string, tone?: LogLine["tone"]) => setLog((l) => [...l.slice(-400), { at: Date.now(), text, tone }]);

  const loadHistory = useCallback(async () => {
    const res = await fetch(`/api/projects/${projectId}/runs`, { cache: "no-store" });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? "Could not load the conversation.");
    setMessages(body.messages);
    return body as { messages: ChatMessage[]; running: boolean };
  }, [projectId]);

  const apply = useCallback((ev: RunEvent) => {
    switch (ev.type) {
      case "run-start":
        setLive((l) => l && { ...l, runId: ev.runId, model: ev.model });
        addLog(`run started · ${ev.provider} · ${ev.model}`, "dim");
        break;
      case "stage":
        setLive((l) => l && { ...l, stage: ev.stage });
        break;
      case "text":
        setLive((l) => l && { ...l, text: l.text + ev.text });
        break;
      case "file-start":
        setLive((l) => l && { ...l, files: [...l.files.filter((f) => f.path !== ev.path), { path: ev.path, bytes: 0, status: "writing" }] });
        break;
      case "file-progress":
        setLive((l) => l && { ...l, files: l.files.map((f) => (f.path === ev.path ? { ...f, bytes: ev.bytes } : f)) });
        break;
      case "file-written":
        setLive((l) => l && { ...l, files: l.files.map((f) => (f.path === ev.path ? { ...f, bytes: ev.bytes, status: "written" } : f)) });
        setFileVersion((v) => v + 1);
        addLog(`write  ${ev.path}  ${kb(ev.bytes)}`, "ok");
        break;
      case "file-deleted":
        setLive((l) => l && { ...l, files: [...l.files, { path: ev.path, bytes: 0, status: "deleted" }] });
        setFileVersion((v) => v + 1);
        addLog(`delete ${ev.path}`);
        break;
      case "file-rejected":
        setLive((l) => l && { ...l, files: [...l.files.filter((f) => f.path !== ev.path), { path: ev.path, bytes: 0, status: "rejected", reason: ev.reason }] });
        addLog(`reject ${ev.path} · ${ev.reason}`, "err");
        break;
      case "memory":
        addLog(`memory ${ev.kind} · ${ev.title}${ev.scope === "user" ? " · all projects" : ""}`, "dim");
        break;
      case "run-end":
        setLastRun(ev);
        addLog(
          `run ${ev.status} · ${(ev.durationMs / 1000).toFixed(1)}s` +
            (ev.firstTokenMs !== null ? ` · first token ${(ev.firstTokenMs / 1000).toFixed(1)}s` : "") +
            (ev.mode === "parallel" && ev.planMs != null ? ` · plan ${(ev.planMs / 1000).toFixed(1)}s, ${ev.calls ?? 0} calls` : "") +
            ` · ${ev.files.length} file${ev.files.length === 1 ? "" : "s"}` +
            (ev.outputTokens ? ` · ${ev.outputTokens.toLocaleString()} output tokens` : "") +
            (ev.error ? ` · ${ev.error}` : ""),
          ev.status === "succeeded" ? "ok" : "err",
        );
        break;
    }
  }, []);

  const send = useCallback(
    async (message: string) => {
      setError(null);
      const controller = new AbortController();
      abortRef.current = controller;
      setMessages((m) => [...(m ?? []), { role: "user", text: message, at: new Date().toISOString() }]);
      setLive({ stage: "plan", text: "", files: [], startedAt: Date.now() });
      try {
        const res = await fetch(`/api/projects/${projectId}/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `Run failed to start (${res.status}).`);
        }
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) if (line.trim()) apply(JSON.parse(line) as RunEvent);
        }
      } catch (e) {
        if (!controller.signal.aborted) setError((e as Error).message);
        else addLog("run stopped", "err");
      } finally {
        abortRef.current = null;
        setLive(null);
        await loadHistory().catch(() => undefined);
      }
    },
    [projectId, apply, loadHistory],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    void fetch(`/api/projects/${projectId}/runs`, { method: "DELETE" });
  }, [projectId]);

  // Load history once; a brand-new project starts building its brief right away.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial load of server state, then optional autostart
    loadHistory()
      .then(({ messages: history, running }) => {
        if (!history.length && !running && !autostarted.current) {
          autostarted.current = true;
          void send(brief);
        }
      })
      .catch((e: Error) => setError(e.message));
  }, [loadHistory, send, brief]);

  return { messages, live, error, running: live !== null, send, stop, fileVersion, log, lastRun };
}
