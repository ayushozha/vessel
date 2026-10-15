import { z } from "zod";

import { readChat } from "@/lib/generator/history";
import { claimRun, isRunning, runGeneration, stopRun } from "@/lib/generator/run";
import { guardLocal } from "@/lib/guard";
import { resolveModel } from "@/lib/models";
import { getProject } from "@/lib/projects";

const Body = z.object({ message: z.string().trim().min(1, "Write a message.").max(8000) });

/** Chat history and whether a run is in progress. */
export async function GET(request: Request, ctx: RouteContext<"/api/projects/[id]/runs">) {
  const blocked = guardLocal(request);
  if (blocked) return blocked;
  const project = await getProject((await ctx.params).id);
  if (!project) return Response.json({ error: "Project not found." }, { status: 404 });
  return Response.json({ messages: await readChat(project.id), running: isRunning(project.id) });
}

/** Start a run and stream its events as newline-delimited JSON. */
export async function POST(request: Request, ctx: RouteContext<"/api/projects/[id]/runs">) {
  const blocked = guardLocal(request);
  if (blocked) return blocked;
  const project = await getProject((await ctx.params).id);
  if (!project) return Response.json({ error: "Project not found." }, { status: 404 });
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid request." }, { status: 400 });

  let resolved;
  try {
    resolved = await resolveModel();
  } catch {
    return Response.json({ error: "Your model connection expired. Reconnect it in onboarding." }, { status: 401 });
  }
  if (!resolved) return Response.json({ error: "Connect a model and choose one first." }, { status: 409 });

  const controller = claimRun(project.id);
  if (!controller) return Response.json({ error: "A run is already in progress for this project." }, { status: 409 });
  // Closing the request (Stop, tab closed) cancels the run.
  request.signal.addEventListener("abort", () => controller.abort(), { once: true });

  const encoder = new TextEncoder();
  const events = runGeneration({ project, message: parsed.data.message, resolved, controller });
  const stream = new ReadableStream<Uint8Array>({
    async pull(sink) {
      const { value, done } = await events.next();
      if (done) sink.close();
      else sink.enqueue(encoder.encode(JSON.stringify(value) + "\n"));
    },
    cancel() {
      controller.abort();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}

/** Stop the active run. */
export async function DELETE(request: Request, ctx: RouteContext<"/api/projects/[id]/runs">) {
  const blocked = guardLocal(request);
  if (blocked) return blocked;
  const stopped = stopRun((await ctx.params).id);
  return new Response(null, { status: stopped ? 202 : 204 });
}
