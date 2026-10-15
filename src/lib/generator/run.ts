// One generation run: the model streams narration and files; files are validated and written as each one closes.
// Server-only.
import { randomUUID } from "node:crypto";
import { streamText, type LanguageModelUsage, type ModelMessage } from "ai";

import type { ResolvedModel } from "../models";
import type { Project } from "../projects";
import { deleteFile, listFiles, snapshot, writeFile } from "../workspace";
import { appendChat, appendRunEvent, readChat, type ChatMessage } from "./history";
import { FileStreamParser } from "./parse";
import { systemPrompt, userPrompt } from "./prompt";

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
  | {
      type: "run-end";
      runId: string;
      status: RunStatus;
      files: FileChange[];
      durationMs: number;
      firstTokenMs: number | null;
      outputTokens: number | null;
      error?: string;
    };

const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_SECONDS ?? 600) * 1000;
const HISTORY_TURNS = 10;

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
  let firstTokenMs: number | null = null;
  let usage: LanguageModelUsage | undefined;
  let narration = "";
  let error: string | undefined;
  let stage: "plan" | "generate" = "plan";
  const files: FileChange[] = [];
  const lastProgress = new Map<string, number>();
  const log = (e: RunEvent) => (e.type === "file-progress" || e.type === "text" ? undefined : appendRunEvent(project.id, runId, e));

  try {
    const chat = await readChat(project.id);
    const hasFiles = (await listFiles(project.id)).length > 0;
    const messages: ModelMessage[] = [
      ...historyMessages(chat),
      { role: "user", content: userPrompt(message, hasFiles ? await snapshot(project.id) : "") },
    ];
    await appendChat(project.id, { role: "user", text: message, at: new Date().toISOString(), runId });

    const startEvent: RunEvent = { type: "run-start", runId, provider: resolved.provider, model: resolved.modelId };
    await log(startEvent);
    yield startEvent;
    yield { type: "stage", stage: "plan" };

    const result = streamText({
      model: resolved.model,
      instructions: systemPrompt(project.kind),
      messages,
      abortSignal: AbortSignal.any([controller.signal, AbortSignal.timeout(RUN_TIMEOUT_MS)]),
      maxRetries: 1,
      providerOptions: resolved.providerOptions,
    });

    const parser = new FileStreamParser();
    const handle = async function* (events: ReturnType<FileStreamParser["feed"]>): AsyncGenerator<RunEvent> {
      for (const ev of events) {
        if (ev.type === "text") {
          narration += ev.text;
          yield { type: "text", text: ev.text };
        } else if (ev.type === "file-start") {
          if (stage === "plan") {
            stage = "generate";
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
            const written = await writeFile(project.id, ev.path, ev.content);
            files.push({ ...written, op: "write" });
            const out: RunEvent = { type: "file-written", ...written };
            await log(out);
            yield out;
          } catch (e) {
            const out: RunEvent = { type: "file-rejected", path: ev.path, reason: errorMessage(e) };
            await log(out);
            yield out;
          }
        } else if (ev.type === "delete") {
          if (await deleteFile(project.id, ev.path)) {
            files.push({ path: ev.path, bytes: 0, op: "delete" });
            const out: RunEvent = { type: "file-deleted", path: ev.path };
            await log(out);
            yield out;
          }
        } else {
          const out: RunEvent = { type: "file-rejected", path: ev.path, reason: ev.reason };
          await log(out);
          yield out;
        }
      }
    };

    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        firstTokenMs ??= Date.now() - started;
        yield* handle(parser.feed(part.text));
      } else if (part.type === "finish") {
        usage = part.totalUsage;
      } else if (part.type === "error") {
        error = errorMessage(part.error);
      }
    }
    yield* handle(parser.end());
  } catch (e) {
    if (!controller.signal.aborted) error = errorMessage(e);
  } finally {
    active.delete(project.id);
  }

  const status: RunStatus = controller.signal.aborted ? "cancelled" : error ? "failed" : "succeeded";
  const end: RunEvent = {
    type: "run-end",
    runId,
    status,
    files,
    durationMs: Date.now() - started,
    firstTokenMs,
    outputTokens: usage?.outputTokens ?? null,
    ...(error ? { error } : {}),
  };
  await log(end);
  await appendChat(project.id, {
    role: "assistant",
    text: tidyNarration(narration),
    at: new Date().toISOString(),
    runId,
    files,
    status,
    ...(error ? { error } : {}),
    metrics: { durationMs: end.durationMs, firstTokenMs, outputTokens: end.outputTokens, model: resolved.modelId },
  });
  yield end;
}
