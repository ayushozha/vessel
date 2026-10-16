import { guardLocal } from "@/lib/guard";
import { getProject, ProjectName, renameProject } from "@/lib/projects";

export async function GET(request: Request, ctx: RouteContext<"/api/projects/[id]">) {
  const blocked = guardLocal(request);
  if (blocked) return blocked;
  const project = await getProject((await ctx.params).id);
  return project ? Response.json(project) : Response.json({ error: "Project not found." }, { status: 404 });
}

export async function PATCH(request: Request, ctx: RouteContext<"/api/projects/[id]">) {
  const blocked = guardLocal(request);
  if (blocked) return blocked;
  const body = await request.json().catch(() => null);
  const name = ProjectName.safeParse(body?.name);
  if (!name.success) return Response.json({ error: name.error.issues[0]?.message ?? "Invalid name." }, { status: 400 });
  const project = await renameProject((await ctx.params).id, name.data);
  return project ? Response.json(project) : Response.json({ error: "Project not found." }, { status: 404 });
}
