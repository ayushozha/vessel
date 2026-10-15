"use client";

import Link from "next/link";
import { useState } from "react";

import { KINDS } from "@/lib/kinds";
import type { Project } from "@/lib/projects";
import type { ActiveModel } from "@/lib/readiness";

import styles from "./builder.module.css";

const STAGES = ["Plan", "Generate", "Run", "Repair", "Verify", "Live"] as const;
const TABS = ["Preview", "Code", "Logs", "Checks", "Resources"] as const;
type Tab = (typeof TABS)[number];
const PROVIDER_NAMES: Record<string, string> = { chatgpt: "ChatGPT", openai: "OpenAI", anthropic: "Anthropic", glm: "GLM" };

export function Builder({ project, active }: { project: Project; active: ActiveModel }) {
  const [tab, setTab] = useState<Tab>("Preview");
  const [draft, setDraft] = useState("");
  const kind = KINDS[project.kind];
  const created = new Date(project.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return (
    <div className={styles.app}>
      <header className={styles.bar}>
        <div className={styles.crumbs}>
          <Link href="/new" className={styles.logo} aria-label="New project">
            <svg viewBox="0 0 22 22" aria-hidden="true">
              <polygon points="11,2 2,19 20,19" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <line x1="11" y1="12" x2="22" y2="8" stroke="#FF3D6E" strokeWidth="1.2" />
              <line x1="11" y1="12" x2="22" y2="12" stroke="#F2B705" strokeWidth="1.2" />
              <line x1="11" y1="12" x2="22" y2="16" stroke="#6D4AFF" strokeWidth="1.2" />
            </svg>
            Vessel
          </Link>
          <span className={styles.slash}>/</span>
          <span className={styles.name} title={project.name}>
            {project.name}
          </span>
          <span className={styles.kindChip}>
            <i style={{ background: kind.color }} />
            {kind.name}
          </span>
        </div>

        <ol className={styles.stages} aria-label="Run stages">
          {STAGES.map((s) => (
            <li key={s}>
              <i />
              {s}
            </li>
          ))}
        </ol>

        <div className={styles.actions}>
          <Link href="/onboarding" className={styles.modelChip} title="Change model">
            <i />
            {PROVIDER_NAMES[active.provider] ?? active.provider} · {active.model}
          </Link>
          <button type="button" className={styles.publish} disabled title="Nothing to publish yet">
            Publish
          </button>
        </div>
      </header>

      <div className={styles.body}>
        <aside className={styles.chat}>
          <div className={styles.thread}>
            <div className={styles.you}>
              <p>{project.brief}</p>
              <span>{created}</span>
            </div>

            <div className={styles.note}>
              <i style={{ background: kind.color }} />
              <div>
                Brief saved as a new {kind.name === "Anything" ? "project" : kind.name.toLowerCase()}. The build engine is not
                connected yet, so nothing has run. Runs will stream here.
              </div>
            </div>

            <div className={styles.planCard}>
              <span className={styles.cardLabel}>What this will produce</span>
              <p className={styles.produces}>{kind.produces}</p>
              <span className={styles.cardLabel}>Resources it will ask for</span>
              <ul>
                {kind.resources.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          </div>

          <form className={styles.composer} onSubmit={(e) => e.preventDefault()}>
            <label htmlFor="message" className="sr-only">
              Message
            </label>
            <textarea
              id="message"
              rows={2}
              placeholder="Ask for a change…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <div className={styles.composerRow}>
              <span>Engine not connected</span>
              <button type="submit" disabled>
                Send
              </button>
            </div>
          </form>
        </aside>

        <section className={styles.pane}>
          <div className={styles.tabs} role="tablist" aria-label="Project views">
            {TABS.map((t) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} data-on={tab === t} onClick={() => setTab(t)}>
                {t}
              </button>
            ))}
          </div>
          <div className={styles.view} role="tabpanel" aria-label={tab}>
            {tab === "Preview" && (
              <div className={styles.browser}>
                <div className={styles.url}>
                  <i />
                  Not deployed yet
                </div>
                <Empty title="Nothing is live yet." text="When a run publishes, the live Wasmer URL opens here." />
              </div>
            )}
            {tab === "Code" && (
              <div className={styles.code}>
                <ul className={styles.tree}>
                  <li className={styles.muted}>No files yet</li>
                </ul>
                <Empty title="No source yet." text="Generated files appear here, and you can open any of them." />
              </div>
            )}
            {tab === "Logs" && (
              <pre className={styles.logs}>
                <span className={styles.muted}>$ waiting for the first run</span>
                <span className={styles.caret} />
              </pre>
            )}
            {tab === "Checks" && (
              <ul className={styles.list}>
                {kind.checks.map((c) => (
                  <li key={c}>
                    <i />
                    <span>{c}</span>
                    <em>Pending</em>
                  </li>
                ))}
              </ul>
            )}
            {tab === "Resources" && (
              <ul className={styles.list}>
                {kind.resources.map((r) => (
                  <li key={r}>
                    <i />
                    <span>{r}</span>
                    <em>Proposed · not provisioned</em>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className={styles.empty}>
      <svg viewBox="0 0 120 80" aria-hidden="true">
        <path d="M0 40 H44" stroke="#C9C9CF" strokeWidth="1" />
        <polygon points="60,14 42,62 78,62" fill="#FFFFFF" stroke="#0A0A0B" strokeOpacity=".4" strokeWidth="1" />
        <g strokeWidth="1" opacity=".55">
          <path d="M69 42 L120 22" stroke="#FF3D6E" />
          <path d="M69 42 L120 36" stroke="#F2B705" />
          <path d="M69 42 L120 50" stroke="#10B981" />
          <path d="M69 42 L120 64" stroke="#6D4AFF" />
        </g>
      </svg>
      <strong>{title}</strong>
      <p>{text}</p>
    </div>
  );
}
