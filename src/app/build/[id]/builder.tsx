"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import type { ChatMessage } from "@/lib/generator/history";
import { Logo } from "@/app/logo";
import { KINDS } from "@/lib/kinds";
import type { Project } from "@/lib/projects";
import type { ActiveModel } from "@/lib/readiness";
import { formatUsd } from "@/lib/format-usd";

import styles from "./builder.module.css";
import { CodeView } from "./code-view";
import { MemoryView } from "./memory-view";
import { ProjectSwitcher } from "./project-switcher";
import { Preview } from "./preview/preview";
import { compact, totalSpend } from "./spend";
import { useRun, type LiveRun } from "./use-run";
import { useRuntime } from "./use-runtime";

const STAGES = ["Plan", "Generate", "Run", "Repair", "Verify", "Live"] as const;
const TABS = ["Preview", "Code", "Logs", "Memory", "Checks", "Resources"] as const;
type Tab = (typeof TABS)[number];
const PROVIDER_NAMES: Record<string, string> = { chatgpt: "ChatGPT", openai: "OpenAI", anthropic: "Anthropic", glm: "GLM" };
const kb = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function Builder({ project, active }: { project: Project; active: ActiveModel }) {
  const [tab, setTab] = useState<Tab>("Preview");
  const [draft, setDraft] = useState("");
  const kind = KINDS[project.kind];
  const run = useRun(project.id, project.brief);
  const runtime = useRuntime(project.id);
  const rt = runtime.status;
  const threadRef = useRef<HTMLDivElement>(null);

  // Which stages are lit: live run state first, otherwise the last finished run.
  const lastAssistant = [...(run.messages ?? [])].reverse().find((m) => m.role === "assistant");
  const generated = lastAssistant?.status === "succeeded" && (lastAssistant.files?.length ?? 0) > 0;
  const stageState = (s: (typeof STAGES)[number]): "done" | "on" | "idle" | "error" => {
    if (run.live) {
      if (s === "Plan") return run.live.stage === "plan" ? "on" : "done";
      if (s === "Generate") return run.live.stage === "generate" ? "on" : "idle";
      return "idle";
    }
    if (s === "Plan" || s === "Generate") return generated ? "done" : "idle";
    if (s === "Run") {
      if (rt?.state === "running") return "done";
      if (rt?.state === "starting" || rt?.state === "restarting") return "on";
      if (rt?.state === "crashed") return "error";
    }
    return "idle";
  };
  const previewNotice =
    rt?.state === "starting" || rt?.state === "restarting"
      ? { title: rt.state === "starting" ? "Starting your app…" : "Restarting…", text: "Booting it in a local Wasmer sandbox." }
      : rt?.state === "crashed"
        ? { title: "The app stopped.", text: rt.error ?? "See the Logs tab for details.", tone: "error" as const }
        : rt?.error && rt.state === "idle"
          ? { title: "Nothing is running yet.", text: rt.error }
          : undefined;

  const spend = useMemo(() => totalSpend(run.messages ?? []), [run.messages]);
  const spendLabel = `${spend.priced ? formatUsd(spend.costUsd) : spend.plan ? "Plan" : "$—"} · ${compact(spend.input + spend.output)} tokens`;
  const spendTitle =
    `${spend.runs} run${spend.runs === 1 ? "" : "s"} · ${spend.input.toLocaleString()} input (${spend.cacheRead.toLocaleString()} cached) · ${spend.output.toLocaleString()} output tokens` +
    (spend.priced ? `\n${formatUsd(spend.costUsd)} on API keys, priced by genai-prices` : "") +
    (spend.plan ? `\n${spend.plan} run${spend.plan === 1 ? "" : "s"} on your ChatGPT plan (no per-token charge)` : "") +
    (spend.unpriced ? `\n${spend.unpriced} run${spend.unpriced === 1 ? "" : "s"} on a model without a known price` : "");
  const changed = useMemo(() => new Set((run.lastRun?.files ?? lastAssistant?.files ?? []).map((f) => f.path)), [run.lastRun, lastAssistant]);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [run.messages, run.live]);

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const text = draft.trim();
    if (!text || run.running) return;
    setDraft("");
    void run.send(text);
  };

  return (
    <div className={styles.app}>
      <header className={styles.bar}>
        <div className={styles.crumbs}>
          <Link href="/projects" className={styles.logo} aria-label="All projects">
            <Logo />
            Adorable
          </Link>
          <span className={styles.slash}>/</span>
          <ProjectSwitcher id={project.id} name={project.name} />
          <span className={styles.kindChip}>
            <i style={{ background: kind.color }} />
            {kind.name}
          </span>
        </div>

        <ol className={styles.stages} aria-label="Run stages">
          {STAGES.map((s) => (
            <li key={s} data-state={stageState(s)} title={s === "Run" && generated ? "Runs in the Wasmer sandbox once the runtime is connected" : undefined}>
              <i />
              {s}
            </li>
          ))}
        </ol>

        <div className={styles.actions}>
          <span className={styles.spendChip} title={spendTitle} aria-label={`Project spend: ${spendTitle}`}>
            {spendLabel}
          </span>
          <Link href="/onboarding" className={styles.modelChip} title="Change model">
            <i />
            {PROVIDER_NAMES[active.provider] ?? active.provider} · {active.model}
          </Link>
          <button type="button" className={styles.publish} disabled title="Publishing to Wasmer Edge comes next">
            Publish
          </button>
        </div>
      </header>

      <div className={styles.body}>
        <aside className={styles.chat}>
          <div className={styles.thread} ref={threadRef} aria-live="polite">
            {run.messages === null && <p className={styles.muted}>Loading conversation…</p>}
            {run.messages?.map((m, i) => (m.role === "user" ? <UserBubble key={i} message={m} /> : <AssistantTurn key={i} message={m} />))}
            {run.live && <LiveTurn live={run.live} />}
            {run.error && <p className={styles.errorBox}>{run.error}</p>}
          </div>

          <form className={styles.composer} onSubmit={submit}>
            <label htmlFor="message" className="sr-only">
              Message
            </label>
            <textarea
              id="message"
              rows={2}
              placeholder={run.running ? "Building…" : "Ask for a change…"}
              value={draft}
              disabled={run.running}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) submit(e);
              }}
            />
            <div className={styles.composerRow}>
              <span>{run.running ? "Writing files…" : "Enter to send"}</span>
              {run.running ? (
                <button type="button" className={styles.stop} onClick={run.stop}>
                  Stop
                </button>
              ) : (
                <button type="submit" disabled={!draft.trim()}>
                  Send
                </button>
              )}
            </div>
          </form>
        </aside>

        <section className={styles.pane}>
          <div className={styles.tabs} role="tablist" aria-label="Project views">
            {TABS.map((t) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} data-on={tab === t} onClick={() => setTab(t)}>
                {t}
                {t === "Code" && changed.size > 0 && <span className={styles.badge}>{changed.size}</span>}
              </button>
            ))}
          </div>
          <div className={styles.view} role="tabpanel" aria-label={tab}>
            {tab === "Preview" && (
              <Preview
                appUrl={rt?.appUrl ?? null}
                notice={previewNotice}
                onRestart={rt && rt.state !== "idle" ? () => void runtime.act("restart") : undefined}
                onResetData={rt?.database ? () => void runtime.act("reset") : undefined}
              />
            )}
            {tab === "Code" && <CodeView projectId={project.id} version={run.fileVersion} changed={changed} />}
            {tab === "Logs" && (
              <pre className={styles.logs}>
                {run.log.length === 0 && <span className={styles.logDim}>$ waiting for the next run</span>}
                {run.log.map((l, i) => (
                  <span key={i} className={l.tone === "ok" ? styles.logOk : l.tone === "err" ? styles.logErr : l.tone === "dim" ? styles.logDim : undefined}>
                    {new Date(l.at).toLocaleTimeString([], { hour12: false })}  {l.text}
                  </span>
                ))}
                {run.running && <span className={styles.caret} />}
                {runtime.logs.length > 0 && <span className={styles.logDim}>{"\n"}── app · {rt?.stack ?? "sandbox"} ──</span>}
                {runtime.logs.map((l, i) => (
                  <span key={`rt${i}`} className={l.stream === "stderr" || l.stream === "error" || l.stream === "exit" ? styles.logErr : undefined}>
                    {new Date(l.at).toLocaleTimeString([], { hour12: false })}  [{l.source}] {l.line}
                  </span>
                ))}
              </pre>
            )}
            {tab === "Memory" && <MemoryView projectId={project.id} version={run.messages?.length ?? 0} />}
            {tab === "Checks" && (
              <ul className={styles.list}>
                {kind.checks.map((c) => (
                  <li key={c}>
                    <i />
                    <span>{c}</span>
                    <em>Pending · needs the sandbox runtime</em>
                  </li>
                ))}
              </ul>
            )}
            {tab === "Resources" && (
              <ul className={styles.list}>
                <li data-on={rt?.state === "running"}>
                  <i />
                  <span>Wasmer sandbox · {rt?.stack === "node-pglite" ? "Edge.js + PostgreSQL" : "Edge.js"}</span>
                  <em>{rt ? (rt.state === "running" ? `Running · ${rt.appUrl}` : rt.state) : "…"}</em>
                </li>
                {rt?.database && (
                  <li data-on={rt.state === "running"}>
                    <i />
                    <span>PostgreSQL (PGlite) · local, persistent, works offline</span>
                    <em>Data survives restarts until Reset data</em>
                  </li>
                )}
                <li data-on={spend.runs > 0}>
                  <i />
                  <span>Model spend · {spend.runs} run{spend.runs === 1 ? "" : "s"}</span>
                  <em>{spendLabel}</em>
                </li>
                {kind.resources.map((r) => (
                  <li key={r}>
                    <i />
                    <span>{r}</span>
                    <em>On Wasmer Edge when you publish</em>
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

function UserBubble({ message }: { message: ChatMessage }) {
  return (
    <div className={styles.you}>
      <p>{message.text}</p>
      <span>{time(message.at)}</span>
    </div>
  );
}

function AssistantTurn({ message }: { message: ChatMessage }) {
  const m = message.metrics;
  return (
    <div className={styles.turn}>
      {message.text && <p className={styles.narration}>{message.text.replace(/\n{3,}/g, "\n\n")}</p>}
      {!!message.files?.length && (
        <ul className={styles.ops}>
          {message.files.map((f) => (
            <li key={f.op + f.path} data-status={f.op === "delete" ? "deleted" : "written"}>
              <i />
              <span>{f.path}</span>
              <em>{f.op === "delete" ? "deleted" : kb(f.bytes)}</em>
            </li>
          ))}
        </ul>
      )}
      {message.status === "failed" && <p className={styles.errorBox}>{message.error ?? "The run failed."}</p>}
      {message.status === "cancelled" && <p className={styles.muted}>Stopped. Files written before stopping were kept.</p>}
      {m && (
        <span className={styles.metrics}>
          {(m.durationMs / 1000).toFixed(1)}s{m.firstTokenMs !== null ? ` · first token ${(m.firstTokenMs / 1000).toFixed(1)}s` : ""} ·{" "}
          {message.files?.length ?? 0} files{m.outputTokens ? ` · ${m.outputTokens.toLocaleString()} tokens` : ""}
          {m.costUsd != null ? ` · ${formatUsd(m.costUsd)}` : m.pricing === "plan" ? " · plan" : ""} · {m.model}
        </span>
      )}
    </div>
  );
}

function LiveTurn({ live }: { live: LiveRun }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  return (
    <div className={styles.turn}>
      <p className={styles.narration}>
        {live.text.replace(/\n{3,}/g, "\n\n").trim() || (live.stage === "plan" ? "Planning…" : "")}
        <span className={styles.cursor} />
      </p>
      {!!live.files.length && (
        <ul className={styles.ops}>
          {live.files.map((f) => (
            <li key={f.path} data-status={f.status} title={f.reason}>
              <i />
              <span>{f.path}</span>
              <em>{f.status === "rejected" ? "rejected" : f.status === "deleted" ? "deleted" : kb(f.bytes)}</em>
            </li>
          ))}
        </ul>
      )}
      <span className={styles.metrics}>
        {live.stage === "plan" ? "Planning" : "Writing files"} · {((now - live.startedAt) / 1000).toFixed(1)}s
      </span>
    </div>
  );
}
