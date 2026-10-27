"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { RenameField, type ProjectSummary } from "@/app/projects/projects-home";

import styles from "./builder.module.css";

/** The project name in the builder header: click to switch projects, double-click to rename. */
export function ProjectSwitcher({ id, name: initial }: { id: string; name: string }) {
  const [name, setName] = useState(initial);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const ac = new AbortController();
    fetch("/api/projects", { cache: "no-store", signal: ac.signal })
      .then((r) => r.json())
      .then((b) => setProjects(b.projects ?? []))
      .catch(() => !ac.signal.aborted && setProjects([]));
    const away = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => {
      ac.abort();
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  async function rename(next: string | null) {
    setEditing(false);
    if (!next || next === name) return;
    const res = await fetch(`/api/projects/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: next }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return setError(body.error ?? "Could not rename.");
    setError(null);
    setName(body.name);
    document.title = `${body.name} · Adorable`;
  }

  if (editing) return <RenameField initial={name} onDone={rename} className={styles.nameInput} />;

  const others = projects?.filter((p) => p.id !== id) ?? [];
  return (
    <div className={styles.switcher} ref={root}>
      <button
        type="button"
        className={styles.name}
        title={error ?? "Switch project · double-click to rename"}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onDoubleClick={() => {
          setOpen(false);
          setEditing(true);
        }}
      >
        {name}
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </button>
      {open && (
        <div className={styles.switchMenu} role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setEditing(true);
            }}
          >
            Rename “{name}”
          </button>
          <p>Switch to</p>
          {projects === null && <span className={styles.switchDim}>Loading…</span>}
          {projects !== null && others.length === 0 && <span className={styles.switchDim}>No other projects yet</span>}
          {others.slice(0, 8).map((p) => (
            <Link key={p.id} href={`/build/${p.id}`} role="menuitem" onClick={() => setOpen(false)}>
              <i data-state={p.runtime.state} />
              <span>{p.name}</span>
            </Link>
          ))}
          <hr />
          <Link href="/projects" role="menuitem">
            All projects
          </Link>
          <Link href="/new" role="menuitem" className={styles.switchNew}>
            + New project
          </Link>
        </div>
      )}
    </div>
  );
}
