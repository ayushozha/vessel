"use client";

import { useCallback, useEffect, useState } from "react";

import type { RuntimeStatus } from "@/lib/runtime";
import type { LogEntry } from "@/lib/sandbox";

type Action = "start" | "restart" | "reset" | "stop";

/** The project's live sandbox: status (polled), lifecycle actions and a log stream. */
export function useRuntime(projectId: string) {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState<Action | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/projects/${projectId}/runtime`, { cache: "no-store" }).catch(() => null);
    if (res?.ok) setStatus(await res.json());
  }, [projectId]);

  const act = useCallback(
    async (action: Action) => {
      setBusy(action);
      try {
        const res = await fetch(`/api/projects/${projectId}/runtime`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        });
        if (res.ok) setStatus(await res.json());
      } finally {
        setBusy(null);
      }
    },
    [projectId],
  );

  // Start on open (a project without server.js just reports why), then poll: quickly while booting.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- start the sandbox once when the builder opens
    void act("start");
  }, [act]);
  const transitional = status?.state === "starting" || status?.state === "restarting" || busy !== null;
  useEffect(() => {
    const t = setInterval(refresh, transitional ? 1000 : 3000);
    return () => clearInterval(t);
  }, [refresh, transitional]);

  // A new sandbox (start, reset) or state change reconnects the log stream; the server replays recent lines.
  const streamKey = `${status?.state}|${status?.appUrl}`;
  useEffect(() => {
    if (!status || status.state === "idle" || status.state === "stopped") return;
    const source = new EventSource(`/api/projects/${projectId}/runtime/logs`);
    let fresh = true;
    source.onmessage = (e) => {
      const entry = JSON.parse(e.data) as LogEntry;
      setLogs((l) => {
        const next = fresh ? [entry] : [...l.slice(-500), entry];
        fresh = false;
        return next;
      });
    };
    source.addEventListener("stopped", () => source.close());
    return () => source.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reconnect only when the sandbox identity changes
  }, [projectId, streamKey]);

  return { status, logs, busy, act, refresh };
}
