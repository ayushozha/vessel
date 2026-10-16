import { z } from "zod";

import { guardLocal } from "@/lib/guard";
import { getProject } from "@/lib/projects";
import { ensureRunning, initRuntimeSync, resetData, restart, status, stop } from "@/lib/runtime";

const Action = z.object({ action: z.enum(["start", "restart", "reset", "stop"]) });

export async function GET(request: Request, ctx: RouteContext<"/api/projects/[id]/runtime">) {
  const blocked = guardLocal(request);
  if (blocked) return blocked;
  const project = await getProject((await ctx.params).id);
  if (!project) return Response.json({ error: "Project not found." }, { status: 404 });
  initRuntimeSync();
  return Response.json(status(project.id));
}

export async function POST(request: Request, ctx: RouteContext<"/api/projects/[id]/runtime">) {
  const blocked = guardLocal(request);
  if (blocked) return blocked;
  const project = await getProject((await ctx.params).id);
  if (!project) return Response.json({ error: "Project not found." }, { status: 404 });
  const parsed = Action.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Unknown action." }, { status: 400 });
  initRuntimeSync();
  const run = { start: ensureRunning, restart, reset: resetData, stop }[parsed.data.action];
  return Response.json(await run(project.id));
}
