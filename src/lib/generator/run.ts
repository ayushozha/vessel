// One generation run. A first generation plans the files, then streams each file from its own model call in parallel;
// follow-ups (and invalid plans) use one streamed call. Files are validated and written as each one closes.
// Server-only.
import { randomUUID } from "node:crypto";
import { streamText, type ModelMessage } from "ai";

import { memoryContext, remember, type NewMemory } from "../memory";
import type { ResolvedModel } from "../models";
import type { Project } from "../projects";
import { deleteFile, listFiles, snapshot, writeFile } from "../workspace";
import { emitWorkspaceChanged } from "../workspace-events";
import { appendChat, appendRunEvent, readChat, type ChatMessage } from "./history";
import { FileStreamParser } from "./parse";
import { parsePlan, type Plan } from "./plan";
import { fileSystemPrompt, fileUserPrompt, planSystemPrompt, systemPrompt, userPrompt } from "./prompt";

export type RunStatus = "succeeded" | "failed" | "cancelled";
export type FileChange = { path: string; bytes: number; op: "write" | "delete" };
export type RunEvent =
  | { type: "run-start"; runId: string; provider: string; model: string }
  | { type: "stage"; stage: "plan" | "generate" }
  | { type: "text"; text: string }
  | { type: "file-start"; path: string }
  | { type: "file-progress"; path: string; bytes: number }
  | { type: "file-written"; path: string; bytes: number }
  | { type: "file-deleted"; path: string }
  | { type: "file-rejected"; path: string; reason: string }
  | { type: "memory"; kind: string; scope: "project" | "user"; title: string }
  | {
      type: "run-end";
      runId: string;
      status: RunStatus;
      files: FileChange[];
      durationMs: number;
      firstTokenMs: number | null;
      /** Summed across every model call of the run. */
      outputTokens: number | null;
      error?: string;
      mode?: "single" | "parallel";
      planMs?: number | null;
      firstFileMs?: number | null;
      /** Wall time of each per-file call (parallel mode). */
      fileMs?: Record<string, number>;
      calls?: number;
    };

const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_SECONDS ?? 600) * 1000;
const HISTORY_TURNS = 10;
/** Per-file calls at once for a first generation; 0 turns planning off (always one pass). */
function concurrency(): number {
  const n = Number(process.env.GENERATION_CONCURRENCY || 4);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 4;
}

// One active run per project; the controller lets Stop cancel it.
const active = new Map<string, AbortController>();
export const isRunning = (projectId: string) => active.has(projectId);
export function stopRun(projectId: string): boolean {
  const controller = active.get(projectId);
  controller?.abort();
  return !!controller;
}
/** Claim the project for a run, or null if one is already running. */
export function claimRun(projectId: string): AbortController | null {
  if (active.has(projectId)) return null;
  const controller = new AbortController();
  active.set(projectId, controller);
  return controller;
}

/** Earlier turns as model messages: requests verbatim, answers as narration plus the files they touched. */
export function historyMessages(chat: ChatMessage[]): ModelMessage[] {
  return chat.slice(-HISTORY_TURNS).map((m) =>
    m.role === "user"
      ? { role: "user", content: m.text }
      : {
          role: "assistant",
          content: [m.text, m.files?.length ? `(Files changed: ${m.files.map((f) => `${f.op} ${f.path}`).join(", ")})` : ""]
            .filter(Boolean)
            .join("\n"),
        },
  );
}

/** Narration around file blocks leaves runs of blank lines; keep at most one. */
export const tidyNarration = (text: string) => text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

function errorMessage(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  // Never echo credentials that a provider error might include.
  return text.replace(/(sk-|sk-ant-|Bearer\s+)[A-Za-z0-9._-]{6,}/g, "$1…").slice(0, 400);
}

/** Run async generators with at most `limit` at once, yielding their items as they arrive. Jobs must not throw. */
export async function* fanOut<T>(jobs: (() => AsyncGenerator<T>)[], limit: number): AsyncGenerator<T> {
  const ready: T[] = [];
  let wake: (() => void) | null = null;
  let running = 0;
  let next = 0;
  const notify = () => {
    wake?.();
    wake = null;
  };
  const launch = () => {
    while (running < limit && next < jobs.length) {
      const job = jobs[next++];
      running++;
      void (async () => {
        try {
          for await (const item of job()) {
            ready.push(item);
            notify();
          }
        } finally {
          running--;
          launch();
          notify();
        }
      })();
    }
  };
  launch();
  while (running > 0 || ready.length) {
    if (ready.length) yield ready.shift()!;
    else await new Promise<void>((resolve) => (wake = resolve));
  }
}

type Run = {
  runId: string;
  project: Project;
  message: string;
  resolved: ResolvedModel;
  controller: AbortController;
  signal: AbortSignal;
  started: number;
  stage: "plan" | "generate";
  narration: string;
  files: FileChange[];
  error?: string;
  firstTokenMs: number | null;
  firstFileMs: number | null;
  outputTokens: number | null;
  calls: number;
  mode: "single" | "parallel";
  planMs: number | null;
  fileMs: Record<string, number>;
  memory: string;
  memories: NewMemory[];
};

/** No stream part for this long means the call is stuck; read per call so tests can shorten it. */
const stallMs = () => Number(process.env.GENERATION_STALL_SECONDS || 90) * 1000;
type CallOutcome = "done" | "stalled";

/**
 * One streamed model call: usage and first-token time go on the run, text is yielded as it arrives.
 * Reads race the run's abort and a stall watchdog, so a connection that never closes cannot hold the run open.
 */
async function* callModel(run: Run, instructions: string, messages: ModelMessage[]): AsyncGenerator<string, CallOutcome> {
  run.calls++;
  const stall = new AbortController();
  const signal = AbortSignal.any([run.signal, stall.signal]);
  const result = streamText({
    model: run.resolved.model,
    instructions,
    messages,
    abortSignal: signal,
    maxRetries: 1,
    providerOptions: run.resolved.providerOptions,
  });
  const reader = result.fullStream.getReader();
  const aborted = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  aborted.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    for (;;) {
      clearTimeout(timer);
      timer = setTimeout(() => stall.abort(), stallMs());
      const { value: part, done } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      if (part.type === "text-delta") {
        run.firstTokenMs ??= Date.now() - run.started;
        yield part.text;
      } else if (part.type === "finish") {
        if (part.totalUsage.outputTokens !== undefined) run.outputTokens = (run.outputTokens ?? 0) + part.totalUsage.outputTokens;
      } else if (part.type === "error") {
        run.error ??= errorMessage(part.error);
      }
    }
  } catch (e) {
    if (!signal.aborted) run.error ??= errorMessage(e);
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => undefined); // never await: a dead connection may not acknowledge
  }
  if (stall.signal.aborted && !run.signal.aborted) return "stalled";
  if (run.signal.aborted && !run.controller.signal.aborted) run.error ??= `run timed out after ${RUN_TIMEOUT_MS / 1000}s`;
  return "done";
}

const stalledMessage = () => `the model stopped responding for ${stallMs() / 1000}s`;

/** Stream one call through the file parser, writing files as they close. With `only`, every other block and all narration are ignored. */
async function* streamFiles(run: Run, instructions: string, messages: ModelMessage[], only?: string): AsyncGenerator<RunEvent, CallOutcome> {
  const parser = new FileStreamParser();
  const lastProgress = new Map<string, number>();
  let wrote = false;
  const handle = async function* (events: ReturnType<FileStreamParser["feed"]>): AsyncGenerator<RunEvent> {
    for (const ev of events) {
      if (only && (ev.type === "text" || ev.type === "delete" || ev.type === "memory" || ev.path !== only)) continue;
      if (ev.type === "text") {
        run.narration += ev.text;
        yield { type: "text", text: ev.text };
      } else if (ev.type === "file-start") {
        if (run.stage === "plan") {
          run.stage = "generate";
          yield { type: "stage", stage: "generate" };
        }
        yield { type: "file-start", path: ev.path };
      } else if (ev.type === "file-delta") {
        // About one progress update per KB keeps the stream light without looking frozen.
        if (ev.bytes - (lastProgress.get(ev.path) ?? 0) >= 1024) {
          lastProgress.set(ev.path, ev.bytes);
          yield { type: "file-progress", path: ev.path, bytes: ev.bytes };
        }
      } else if (ev.type === "file-end") {
        try {
          const written = await writeFile(run.project.id, ev.path, ev.content);
          run.files.push({ ...written, op: "write" });
          run.firstFileMs ??= Date.now() - run.started;
          wrote = true;
          yield { type: "file-written", ...written };
        } catch (e) {
          yield { type: "file-rejected", path: ev.path, reason: errorMessage(e) };
        }
      } else if (ev.type === "memory") {
        if (run.memories.length < 5) {
          run.memories.push({ kind: ev.kind, scope: ev.scope, title: ev.title, body: ev.body, authority: "agent" });
          yield { type: "memory", kind: ev.kind, scope: ev.scope, title: ev.title };
        }
      } else if (ev.type === "delete") {
        if (await deleteFile(run.project.id, ev.path)) {
          run.files.push({ path: ev.path, bytes: 0, op: "delete" });
          yield { type: "file-deleted", path: ev.path };
        }
      } else {
        yield { type: "file-rejected", path: ev.path, reason: ev.reason };
      }
    }
  };

  const call = callModel(run, instructions, messages);
  let step = await call.next();
  for (; !step.done; step = await call.next()) yield* handle(parser.feed(step.value));
  if (step.value === "stalled") {
    if (only) yield { type: "file-rejected", path: only, reason: stalledMessage() };
    return "stalled";
  }
  yield* handle(parser.end());
  if (only && !wrote && !run.signal.aborted && !run.error) yield { type: "file-rejected", path: only, reason: "the model did not write this file" };
  return "done";
}

/** Ask for the plan. Null with a reason when the reply is unusable; null without one when the call itself failed or was stopped. */
async function requestPlan(run: Run, messages: ModelMessage[]): Promise<{ plan: Plan } | { plan: null; reason?: string }> {
  const t0 = Date.now();
  let text = "";
  const call = callModel(run, planSystemPrompt(run.project.kind), messages);
  let step = await call.next();
  for (; !step.done; step = await call.next()) text += step.value;
  run.planMs = Date.now() - t0;
  if (step.value === "stalled") run.error ??= stalledMessage();
  if (run.error || run.signal.aborted) return { plan: null };
  const parsed = parsePlan(text);
  return parsed.ok ? { plan: parsed.plan } : { plan: null, reason: parsed.reason };
}

/** Write every planned file from its own call, a few at a time. */
async function* generateFromPlan(run: Run, plan: Plan): AsyncGenerator<RunEvent> {
  run.mode = "parallel";
  run.narration += plan.summary;
  yield { type: "text", text: plan.summary };
  run.stage = "generate";
  yield { type: "stage", stage: "generate" };

  const planJson = JSON.stringify(plan, null, 2);
  const instructions = fileSystemPrompt(run.project.kind);
  const jobs = plan.files.map((file) =>
    async function* (): AsyncGenerator<RunEvent> {
      const t0 = Date.now();
      const messages: ModelMessage[] = [{ role: "user", content: fileUserPrompt(run.message, planJson, file, run.memory) }];
      // A stuck call gets one fresh attempt; a second stall fails the run (other files still land).
      for (let attempt = 1; attempt <= 2 && !run.signal.aborted; attempt++) {
        if ((yield* streamFiles(run, instructions, messages, file.path)) === "done") break;
        if (attempt === 2) run.error ??= `${file.path}: ${stalledMessage()}`;
      }
      run.fileMs[file.path] = Date.now() - t0;
    },
  );
  yield* fanOut(jobs, concurrency());

  const written = run.files.length;
  const closing = `\n\nWrote ${written} of ${plan.files.length} planned file${plan.files.length === 1 ? "" : "s"}.`;
  run.narration += closing;
  yield { type: "text", text: closing };
}

async function* generate(run: Run): AsyncGenerator<RunEvent> {
  const { project, message, resolved } = run;
  const chat = await readChat(project.id);
  const hasFiles = (await listFiles(project.id)).length > 0;
  run.memory = await memoryContext(project.id).catch(() => "");
  const messages: ModelMessage[] = [
    ...historyMessages(chat),
    { role: "user", content: userPrompt(message, hasFiles ? await snapshot(project.id) : "", run.memory) },
  ];
  // The first brief is the project's founding decision: every later edit should be able to see it.
  if (!hasFiles && !chat.length) {
    run.memories.push({ kind: "decision", scope: "project", title: "Original brief", body: message.slice(0, 2000), authority: "human" });
  }
  await appendChat(project.id, { role: "user", text: message, at: new Date().toISOString(), runId: run.runId });

  yield { type: "run-start", runId: run.runId, provider: resolved.provider, model: resolved.modelId };
  yield { type: "stage", stage: "plan" };

  if (!hasFiles && concurrency() > 0) {
    const planned = await requestPlan(run, messages);
    if (planned.plan) {
      await appendRunEvent(project.id, run.runId, { type: "plan", planMs: run.planMs, plan: planned.plan });
      return yield* generateFromPlan(run, planned.plan);
    }
    if (!planned.reason) return; // the plan call failed or was stopped; the run ends with that status
    console.warn(`[vessel] plan rejected, falling back to a single pass: ${planned.reason}`);
    await appendRunEvent(project.id, run.runId, { type: "plan-fallback", reason: planned.reason });
  }
  if ((yield* streamFiles(run, systemPrompt(project.kind), messages)) === "stalled") run.error ??= stalledMessage();
}

export async function* runGeneration({
  project,
  message,
  resolved,
  controller,
}: {
  project: Project;
  message: string;
  resolved: ResolvedModel;
  controller: AbortController;
}): AsyncGenerator<RunEvent> {
  const runId = randomUUID();
  const started = Date.now();
  const run: Run = {
    runId,
    project,
    message,
    resolved,
    controller,
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(RUN_TIMEOUT_MS)]),
    started,
    stage: "plan",
    narration: "",
    files: [],
    firstTokenMs: null,
    firstFileMs: null,
    outputTokens: null,
    calls: 0,
    mode: "single",
    planMs: null,
    fileMs: {},
    memory: "",
    memories: [],
  };
  const log = (e: RunEvent) => (e.type === "file-progress" || e.type === "text" ? undefined : appendRunEvent(project.id, runId, e));

  try {
    for await (const event of generate(run)) {
      await log(event);
      yield event;
    }
  } catch (e) {
    if (!controller.signal.aborted) run.error ??= errorMessage(e);
  } finally {
    active.delete(project.id);
  }
  if (run.signal.aborted && !controller.signal.aborted) run.error ??= `run timed out after ${RUN_TIMEOUT_MS / 1000}s`;

  const status: RunStatus = controller.signal.aborted ? "cancelled" : run.error ? "failed" : "succeeded";
  // One batch per run, so the sandbox syncs (and restarts) once rather than after every file.
  emitWorkspaceChanged({ projectId: project.id, paths: run.files.map((f) => f.path), source: "generator" });
  // In the background: the reply should not wait on Provena. Failed runs keep only what the user said.
  const keep = status === "succeeded" ? run.memories : run.memories.filter((m) => m.authority === "human");
  if (keep.length || run.files.length) void remember(project.id, keep);
  const end: RunEvent = {
    type: "run-end",
    runId,
    status,
    files: run.files,
    durationMs: Date.now() - started,
    firstTokenMs: run.firstTokenMs,
    outputTokens: run.outputTokens,
    ...(run.error ? { error: run.error } : {}),
    mode: run.mode,
    planMs: run.planMs,
    firstFileMs: run.firstFileMs,
    fileMs: run.fileMs,
    calls: run.calls,
  };
  await log(end);
  await appendChat(project.id, {
    role: "assistant",
    text: tidyNarration(run.narration),
    at: new Date().toISOString(),
    runId,
    files: run.files,
    status,
    ...(run.error ? { error: run.error } : {}),
    metrics: {
      durationMs: end.durationMs,
      firstTokenMs: run.firstTokenMs,
      outputTokens: run.outputTokens,
      model: resolved.modelId,
      mode: run.mode,
      planMs: run.planMs,
      firstFileMs: run.firstFileMs,
      calls: run.calls,
    },
  });
  yield end;
}
