import { z } from "zod";

import { MEMORY_KINDS } from "@/lib/generator/parse";
import { guardLocal } from "@/lib/guard";
import { listMemories, memoryAvailable, remember } from "@/lib/memory";
import { getProject } from "@/lib/projects";

const NewMemory = z.object({
  kind: z.enum(MEMORY_KINDS),
  scope: z.enum(["project", "user"]).default("project"),
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1).max(2000),
});

export async function GET(request: Request, ctx: RouteContext<"/api/projects/[id]/memory">) {
  const blocked = guardLocal(request);
  if (blocked) return blocked;
  const project = await getProject((await ctx.params).id);
  if (!project) return Response.json({ error: "Project not found." }, { status: 404 });
  return Response.json({ available: memoryAvailable(), memories: await listMemories(project.id) });
}

/** A memory the user adds by hand: stored with human authority, so it outranks what the agent recorded. */
export async function POST(request: Request, ctx: RouteContext<"/api/projects/[id]/memory">) {
  const blocked = guardLocal(request);
  if (blocked) return blocked;
  const project = await getProject((await ctx.params).id);
  if (!project) return Response.json({ error: "Project not found." }, { status: 404 });
  if (!memoryAvailable()) return Response.json({ error: "Provena is not installed. Run pnpm setup:provena." }, { status: 503 });
  const parsed = NewMemory.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "A memory needs a kind, a title and a body." }, { status: 400 });
  await remember(project.id, [{ ...parsed.data, authority: "human" }], { refresh: false });
  return Response.json({ memories: await listMemories(project.id) }, { status: 201 });
}
