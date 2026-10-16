"use client";

import { useEffect, useState } from "react";

import type { Memory } from "@/lib/memory";

import styles from "./builder.module.css";

const KINDS = ["decision", "preference", "invariant", "mistake", "workflow", "fact"] as const;

/** What Provena remembers about this project (and the user), plus a form to add a rule by hand. */
export function MemoryView({ projectId, version }: { projectId: string; version: number }) {
  const [data, setData] = useState<{ available: boolean; memories: Memory[] } | null>(null);
  const [form, setForm] = useState({ kind: "preference", scope: "project", title: "", body: "" });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    // Agent memories are written in the background after a run, so look again shortly after.
    const load = () =>
      fetch(`/api/projects/${projectId}/memory`, { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => live && setData(d))
        .catch(() => undefined);
    void load();
    const again = setTimeout(load, 4000);
    return () => {
      live = false;
      clearTimeout(again);
    };
  }, [projectId, version]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/projects/${projectId}/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const body = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) return setError(body.error ?? "Could not save the memory.");
    setData((d) => ({ available: true, memories: body.memories ?? d?.memories ?? [] }));
    setForm((f) => ({ ...f, title: "", body: "" }));
  }

  if (!data) return <p className={styles.muted}>Loading memory…</p>;
  if (!data.available)
    return (
      <div className={styles.empty}>
        <strong>Memory is off.</strong>
        <p>Install Provena with pnpm setup:provena to keep decisions and preferences across edits.</p>
      </div>
    );

  return (
    <div className={styles.memory}>
      <form className={styles.memoryForm} onSubmit={add}>
        <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} aria-label="Kind">
          {KINDS.map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
        <select value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })} aria-label="Applies to">
          <option value="project">this project</option>
          <option value="user">all my projects</option>
        </select>
        <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Rule, e.g. Never delete tickets" aria-label="Title" maxLength={160} required />
        <input value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} placeholder="Why, or details" aria-label="Details" maxLength={2000} required />
        <button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Remember"}
        </button>
      </form>
      {error && <p className={styles.errorBox}>{error}</p>}
      {data.memories.length === 0 ? (
        <p className={styles.muted}>Nothing remembered yet. Decisions and preferences from each run land here.</p>
      ) : (
        <ul className={styles.list}>
          {data.memories.map((m) => (
            <li key={m.id} data-on={m.authority === "human"}>
              <i />
              <span>
                <b>{m.kind}</b> · {m.title}
                <small>{m.body}</small>
              </span>
              <em>
                {m.authority === "human" ? "You" : "Agent"}
                {m.scope === "user" ? " · all projects" : ""}
              </em>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
