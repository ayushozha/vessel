"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { KIND_IDS, KINDS, type Kind } from "@/lib/kinds";

import styles from "./new.module.css";

const PROVIDER_NAMES: Record<string, string> = { chatgpt: "ChatGPT", openai: "OpenAI", anthropic: "Anthropic", glm: "GLM" };

export function NewProject({ provider, model }: { provider: string; model: string }) {
  const router = useRouter();
  const [kind, setKind] = useState<Kind>("app");
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = KINDS[kind];

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, brief }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Could not create the project (${res.status}).`);
      router.push(`/build/${body.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <main className={styles.page}>
      <header className={styles.mark}>
        <b>Adorable</b>
        <span>Step 3 · What are you building?</span>
      </header>

      <form className={styles.body} onSubmit={create}>
        <div className={styles.head}>
          <h1 className={styles.title}>
            What are we <span className={styles.u}>making?</span>
          </h1>
          <Link href="/onboarding" className={styles.model}>
            <i /> {PROVIDER_NAMES[provider] ?? provider} · {model}
          </Link>
        </div>

        <div className={styles.kinds} role="radiogroup" aria-label="What to build">
          {KIND_IDS.map((id) => {
            const k = KINDS[id];
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={kind === id}
                data-selected={kind === id}
                className={styles.kind}
                onClick={() => setKind(id)}
              >
                <span className={styles.kindTop}>
                  <i style={{ background: k.color }} />
                  <span className={styles.kindName}>{k.name}</span>
                </span>
                <span className={styles.kindTag}>{k.tagline}</span>
                <span className={styles.kindProduces}>{k.produces}</span>
                <span className={styles.kindRes}>
                  {k.resources.map((r) => (
                    <span key={r}>{r}</span>
                  ))}
                </span>
              </button>
            );
          })}
        </div>

        <div className={styles.prompt}>
          <label htmlFor="brief" className={styles.label}>
            <span>
              <i style={{ background: selected.color }} />
              Describe your {selected.name === "Anything" ? "project" : selected.name.toLowerCase()}
            </span>
            <span>{brief.trim().length} / 4000</span>
          </label>
          <textarea
            id="brief"
            className={styles.textarea}
            rows={3}
            maxLength={4000}
            placeholder={selected.placeholder}
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
            }}
          />
          <div className={styles.row}>
            <div className={styles.examples} aria-label="Example prompts">
              {selected.examples.map((ex) => (
                <button key={ex} type="button" className={styles.example} onClick={() => setBrief(ex)}>
                  {ex}
                </button>
              ))}
            </div>
            <button type="submit" className={styles.btn} disabled={busy || brief.trim().length < 3}>
              {busy ? "Creating…" : "Continue →"}
            </button>
          </div>
          {error && <p className={styles.err}>{error}</p>}
        </div>
      </form>

      <footer className={styles.footer}>
        <Link href="/onboarding">← Step 2 · Model</Link>
        <Link href="/projects">All projects</Link>
        <span>Nothing runs until the builder opens.</span>
      </footer>
    </main>
  );
}
