"use client";

import { useEffect, useMemo, useState } from "react";

import styles from "./builder.module.css";

type Entry = { path: string; bytes: number };
const PREFERRED = ["server.js", "index.js", "public/index.html", "index.html", "package.json"];

/** File tree and read-only viewer for the project workspace. Refreshes when `version` changes. */
export function CodeView({ projectId, version, changed }: { projectId: string; version: number; changed: Set<string> }) {
  const [files, setFiles] = useState<Entry[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/projects/${projectId}/files`, { cache: "no-store" })
      .then((r) => r.json())
      .then((body: { files: Entry[] }) => {
        if (cancelled) return;
        setFiles(body.files);
        setSelected((s) => (s && body.files.some((f) => f.path === s) ? s : (PREFERRED.find((p) => body.files.some((f) => f.path === p)) ?? body.files[0]?.path ?? null)));
      })
      .catch(() => !cancelled && setError("Could not list files."));
    return () => {
      cancelled = true;
    };
  }, [projectId, version]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    fetch(`/api/projects/${projectId}/files?path=${encodeURIComponent(selected)}`, { cache: "no-store" })
      .then(async (r) => {
        const body = await r.json();
        if (!cancelled) setContent(r.ok ? body.content : (body.error ?? "Could not open this file."));
      })
      .catch(() => !cancelled && setContent("Could not open this file."));
    return () => {
      cancelled = true;
    };
  }, [projectId, selected, version]);

  const lines = useMemo(() => content.replace(/\n$/, "").split("\n"), [content]);

  if (error) return <p className={styles.muted}>{error}</p>;
  if (files && !files.length) {
    return (
      <div className={styles.code}>
        <ul className={styles.tree}>
          <li className={styles.muted}>No files yet</li>
        </ul>
        <div className={styles.empty}>
          <strong>No source yet.</strong>
          <p>Files appear here the moment the model writes them.</p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.code}>
      <ul className={styles.tree} aria-label="Files">
        {(files ?? []).flatMap((f, i, all) => {
          const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
          const prevDir = i > 0 && all[i - 1].path.includes("/") ? all[i - 1].path.slice(0, all[i - 1].path.lastIndexOf("/")) : "";
          const depth = dir ? dir.split("/").length : 0;
          return [
            ...(dir && dir !== prevDir ? [<li key={`dir:${dir}`} className={styles.dir}>{dir}/</li>] : []),
            <li key={f.path}>
              <button type="button" data-on={f.path === selected} onClick={() => setSelected(f.path)} title={`${f.path} · ${f.bytes} bytes`}>
                <span style={{ paddingLeft: depth * 12 }}>{f.path.split("/").pop()}</span>
                {changed.has(f.path) && <i aria-label="changed in the last run" />}
              </button>
            </li>,
          ];
        })}
      </ul>
      <div className={styles.source}>
        {selected && <div className={styles.sourceHead}>{selected}</div>}
        <pre>
          {lines.map((line, i) => (
            <span key={i} className={styles.line}>
              <em>{i + 1}</em>
              {line || " "}
            </span>
          ))}
        </pre>
      </div>
    </div>
  );
}
