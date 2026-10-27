// Chat history and run event logs, stored next to the project. Server-only.
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { isProjectId, vesselHome } from "../projects";

export const ChatMessage = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  at: z.string(),
  runId: z.string().optional(),
  files: z.array(z.object({ path: z.string(), bytes: z.number(), op: z.enum(["write", "delete"]) })).optional(),
  status: z.enum(["succeeded", "failed", "cancelled"]).optional(),
  error: z.string().optional(),
  metrics: z
    .object({
      durationMs: z.number(),
      firstTokenMs: z.number().nullable(),
      outputTokens: z.number().nullable(),
      usage: z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(), reasoning: z.number() }).optional(),
      costUsd: z.number().nullable().optional(),
      pricing: z.enum(["api", "plan", "unknown"]).optional(),
      model: z.string(),
      mode: z.enum(["single", "parallel"]).optional(),
      planMs: z.number().nullable().optional(),
      firstFileMs: z.number().nullable().optional(),
      calls: z.number().optional(),
    })
    .optional(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

function projectDir(projectId: string) {
  if (!isProjectId(projectId)) throw new Error("invalid project id");
  return path.join(vesselHome(), "projects", projectId);
}
const chatFile = (id: string) => path.join(projectDir(id), "chat.json");
const runFile = (id: string, runId: string) => {
  if (!/^[0-9a-f-]{36}$/.test(runId)) throw new Error("invalid run id");
  return path.join(projectDir(id), "runs", `${runId}.jsonl`);
};

export async function readChat(projectId: string): Promise<ChatMessage[]> {
  try {
    return z.array(ChatMessage).parse(JSON.parse(await fs.readFile(/*turbopackIgnore: true*/ chatFile(projectId), "utf8")));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

// One writer per project at a time (a run holds the project lock), so read-append-write is safe here.
export async function appendChat(projectId: string, message: ChatMessage) {
  const messages = [...(await readChat(projectId)), ChatMessage.parse(message)];
  const file = chatFile(projectId);
  await fs.mkdir(/*turbopackIgnore: true*/ path.dirname(file), { recursive: true });
  await fs.writeFile(/*turbopackIgnore: true*/ `${file}.tmp`, JSON.stringify(messages, null, 2));
  await fs.rename(/*turbopackIgnore: true*/ `${file}.tmp`, file);
}

export async function appendRunEvent(projectId: string, runId: string, event: object) {
  const file = runFile(projectId, runId);
  await fs.mkdir(/*turbopackIgnore: true*/ path.dirname(file), { recursive: true });
  await fs.appendFile(/*turbopackIgnore: true*/ file, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n");
}

export async function readRunEvents(projectId: string, runId: string): Promise<object[]> {
  try {
    const text = await fs.readFile(/*turbopackIgnore: true*/ runFile(projectId, runId), "utf8");
    return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}
