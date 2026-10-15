import { guardLocal } from "@/lib/guard";
import { getProject } from "@/lib/projects";

export async function GET(request: Request, ctx: RouteContext<"/api/projects/[id]">) {
  const blocked = guardLocal(request);
  if (blocked) return blocked;
  const project = await getProject((await ctx.params).id);
  return project ? Response.json(project) : Response.json({ error: "Project not found." }, { status: 404 });
}
