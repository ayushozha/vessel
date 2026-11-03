"use client";

import { useCallback, useEffect, useState } from "react";

import type { DeployStatus } from "@/lib/deploy";

/** Publishing to Wasmer Edge: the saved app, the publish in progress (polled while it runs) and a start action. */
export function useDeploy(projectId: string) {
  const [status, setStatus] = useState<DeployStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/projects/${projectId}/deploy`, { cache: "no-store" }).catch(() => null);
    if (res?.ok) setStatus(await res.json());
  }, [projectId]);

  const publish = useCallback(async () => {
    setStarting(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/deploy`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Publishing failed (${res.status}).`);
      setStatus(body as DeployStatus);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  }, [projectId]);

  const step = status?.job?.step;
  const active = starting || (!!step && step !== "live" && step !== "failed");

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load the saved deployment once when the builder opens
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(refresh, 1500);
    return () => clearInterval(t);
  }, [active, refresh]);

  return { status, error, active, publish };
}
