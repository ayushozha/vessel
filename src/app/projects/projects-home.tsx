"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { Logo } from "@/app/logo";
import { KINDS, type Kind } from "@/lib/kinds";
import type { Project } from "@/lib/projects";
import type { RuntimeStatus } from "@/lib/runtime";

import styles from "./projects.module.css";

export type ProjectSummary = Project & { files: number; runtime: RuntimeStatus };

const PROVIDER_NAMES: Record<string, string> = { chatgpt: "ChatGPT", openai: "OpenAI", anthropic: "Anthropic", glm: "GLM" };

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Every project, each with a live preview of its running app. */
export function ProjectsHome({ model }: { model: { provider: string; model: string } | null }) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/projects", { cache: "no-store" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return setError(body.error ?? "Could not load projects.");
    setProjects(body.projects);
  }, []);

  useEffect(() => {
    const first = setTimeout(load, 0);
    const t = setInterval(load, 4000); // pick up apps that start or stop
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  async function rename(id: string, name: string) {
    const res = await fetch(`/api/projects/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return setError(body.error ?? "Could not rename the project.");
    setError(null);
    setProjects((ps) => ps?.map((p) => (p.id === id ? { ...p, name: body.name } : p)) ?? ps);
  }

  async function run(id: string) {
    setProjects((ps) => ps?.map((p) => (p.id === id ? { ...p, runtime: { ...p.runtime, state: "starting", error: null } } : p)) ?? ps);
    await fetch(`/api/projects/${id}/runtime`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "start" }) });
    await load();
  }

  const q = query.trim().toLowerCase();
  const shown = projects?.filter((p) => !q || `${p.name} ${p.brief} ${p.kind}`.toLowerCase().includes(q)) ?? [];
  const running = projects?.filter((p) => p.runtime.state === "running").length ?? 0;

  return (
    <div className={styles.page}>
      <header className={styles.bar}>
        <Link href="/" className={styles.logo} aria-label="Adorable home">
          <Logo />
          Adorable
        </Link>
        <Link href="/onboarding" className={styles.modelChip} title="Change model">
          <i />
          {model ? `${PROVIDER_NAMES[model.provider] ?? model.provider} · ${model.model}` : "Connect a model"}
        </Link>
      </header>

      <main className={styles.main}>
        <div className={styles.head}>
          <div>
            <p className={styles.mark}>Your projects</p>
            <h1>
              Everything you have <span className={styles.u}>built.</span>
            </h1>
            <p className={styles.sub}>
              {projects ? `${projects.length} project${projects.length === 1 ? "" : "s"} · ${running} running` : "Loading…"}
            </p>
          </div>
          <div className={styles.tools}>
            <input type="search" placeholder="Search projects" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search projects" />
            <Link href="/new" className={styles.primary}>
              New project
            </Link>
          </div>
        </div>
        {error && <p className={styles.error}>{error}</p>}

        <ul className={styles.grid}>
          <li>
            <Link href="/new" className={styles.newCard}>
              <span className={styles.plus} aria-hidden="true">
                +
              </span>
              <b>New project</b>
              <em>Describe an app, agent or MCP server</em>
            </Link>
          </li>
          {shown.map((p) => (
            <li key={p.id}>
              <ProjectCard project={p} onRename={(name) => rename(p.id, name)} onRun={() => run(p.id)} />
            </li>
          ))}
        </ul>
        {projects && q && shown.length === 0 && <p className={styles.empty}>No project matches “{query}”.</p>}
      </main>
    </div>
  );
}

function ProjectCard({ project: p, onRename, onRun }: { project: ProjectSummary; onRename: (name: string) => void; onRun: () => void }) {
  const kind = KINDS[p.kind as Kind];
  const [editing, setEditing] = useState(false);
  const state = p.runtime.state;
  const label = state === "running" ? "Running" : state === "starting" || state === "restarting" ? "Starting" : state === "crashed" ? "Stopped" : p.files ? "Not running" : "Not built yet";

  return (
    <article className={styles.card} data-state={state}>
      <Link href={`/build/${p.id}`} className={styles.shot} aria-label={`Open ${p.name}`}>
        {state === "running" && p.runtime.appUrl ? (
          <LivePreview url={p.runtime.appUrl} title={`${p.name} preview`} />
        ) : (
          <span className={styles.placeholder}>
            <i style={{ background: kind.color }} />
            <span>{p.files ? "Preview is off" : "Nothing built yet"}</span>
          </span>
        )}
      </Link>
      <div className={styles.meta}>
        {editing ? (
          <RenameField
            initial={p.name}
            onDone={(name) => {
              setEditing(false);
              if (name && name !== p.name) onRename(name);
            }}
          />
        ) : (
          <h2 className={styles.name} onDoubleClick={() => setEditing(true)} title="Double-click to rename">
            {p.name}
          </h2>
        )}
        <p className={styles.brief}>{p.brief}</p>
        <div className={styles.row}>
          <span className={styles.kind}>
            <i style={{ background: kind.color }} />
            {kind.name}
          </span>
          <span className={styles.status} data-state={state}>
            <i />
            {label}
          </span>
          <span className={styles.time}>{ago(p.createdAt)}</span>
        </div>
        <div className={styles.actions}>
          <Link href={`/build/${p.id}`} className={styles.open}>
            Open
          </Link>
          {p.files > 0 && state !== "running" && (
            <button type="button" onClick={onRun} disabled={state === "starting" || state === "restarting"}>
              {state === "starting" || state === "restarting" ? "Starting…" : "Run preview"}
            </button>
          )}
          {state === "running" && p.runtime.appUrl && (
            <a href={p.runtime.appUrl} target="_blank" rel="noreferrer">
              Open app ↗
            </a>
          )}
          <button type="button" onClick={() => setEditing(true)}>
            Rename
          </button>
        </div>
      </div>
    </article>
  );
}

/** The running app at desktop size, scaled down to fit the card. Not interactive: clicking opens the project. */
function LivePreview({ url, title }: { url: string; title: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const [scale, setScale] = useState(0.25);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setScale(e.contentRect.width / 1280));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <span ref={box} className={styles.live}>
      <iframe
        src={url}
        title={title}
        tabIndex={-1}
        loading="lazy"
        sandbox="allow-scripts allow-same-origin allow-forms"
        referrerPolicy="no-referrer"
        style={{ transform: `scale(${scale})` }}
      />
    </span>
  );
}

export function RenameField({ initial, onDone, className }: { initial: string; onDone: (name: string | null) => void; className?: string }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  return (
    <input
      className={className ?? styles.renameInput}
      value={value}
      maxLength={80}
      autoFocus
      aria-label="Project name"
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(value.trim() || null)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(value.trim() || null);
        if (e.key === "Escape") finish(null);
      }}
    />
  );
}
