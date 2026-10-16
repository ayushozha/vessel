import { guardLocal } from "@/lib/guard";
import { getProject } from "@/lib/projects";
import { listFiles, readFile, validatePath } from "@/lib/workspace";

/** List workspace files, or return one file's content with ?path=. */
export async function GET(request: Request, ctx: RouteContext<"/api/projects/[id]/files">) {
  const blocked = guardLocal(request);
  if (blocked) return blocked;
  const project = await getProject((await ctx.params).id);
  if (!project) return Response.json({ error: "Project not found." }, { status: 404 });

  const wanted = new URL(request.url).searchParams.get("path");
  if (wanted === null) return Response.json({ files: await listFiles(project.id) });

  const checked = validatePath(wanted);
  if (!checked.ok) return Response.json({ error: checked.reason }, { status: 400 });
  const content = await readFile(project.id, checked.path);
  return content === null
    ? Response.json({ error: "File not found or too large to show." }, { status: 404 })
    : Response.json({ path: checked.path, content });
}
