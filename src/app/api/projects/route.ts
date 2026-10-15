import { guardLocal } from "@/lib/guard";
import { createProject, listProjects, NewProject } from "@/lib/projects";
import { getActiveModel } from "@/lib/readiness";

export async function GET(request: Request) {
  const blocked = guardLocal(request);
  if (blocked) return blocked;
  return Response.json({ projects: await listProjects() });
}

export async function POST(request: Request) {
  const blocked = guardLocal(request);
  if (blocked) return blocked;
  if (!(await getActiveModel())) return Response.json({ error: "Connect a model first." }, { status: 409 });
  const parsed = NewProject.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
  return Response.json(await createProject(parsed.data), { status: 201 });
}
