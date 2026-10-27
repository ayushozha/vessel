import { guardLocal } from "@/lib/guard";
import { createProject, listProjects, NewProject } from "@/lib/projects";
import { initRuntimeSync, status } from "@/lib/runtime";
import { listFiles } from "@/lib/workspace";
import { getActiveModel } from "@/lib/readiness";

export async function GET(request: Request) {
  const blocked = guardLocal(request);
  if (blocked) return blocked;
  initRuntimeSync();
  // Each project with what the projects home shows: how many files it has and whether its app is running.
  const projects = await Promise.all(
    (await listProjects()).map(async (p) => ({ ...p, files: (await listFiles(p.id).catch(() => [])).length, runtime: status(p.id) })),
  );
  return Response.json({ projects });
}

export async function POST(request: Request) {
  const blocked = guardLocal(request);
  if (blocked) return blocked;
  if (!(await getActiveModel())) return Response.json({ error: "Connect a model first." }, { status: 409 });
  const parsed = NewProject.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
  return Response.json(await createProject(parsed.data), { status: 201 });
}
