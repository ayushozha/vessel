// Local project store. Server-only. One JSON file per project, separate from credentials.
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

import { KIND_IDS } from "./kinds";

export const vesselHome = () => process.env.VESSEL_HOME || path.join(os.homedir(), ".config", "vessel");
const projectsDir = () => path.join(vesselHome(), "projects");

// Ids are UUIDs we generate; anything else is rejected before touching the filesystem.
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const NewProject = z.object({
  kind: z.enum(["app", "agent", "mcp", "anything"] satisfies typeof KIND_IDS),
  brief: z.string().trim().min(3, "Describe what you want to build.").max(4000),
  name: z.string().trim().min(1).max(80).optional(),
});

const Project = NewProject.extend({
  id: z.string().regex(ID_PATTERN),
  name: z.string(),
  createdAt: z.string(),
});
export type Project = z.infer<typeof Project>;

/** A short name from the brief: its first few words, capitalized. */
export function nameFromBrief(brief: string): string {
  const words = brief.replace(/[^\p{L}\p{N}\s'-]/gu, " ").split(/\s+/).filter(Boolean).slice(0, 5).join(" ");
  const name = words || "Untitled project";
  return (name[0].toUpperCase() + name.slice(1)).slice(0, 80);
}

export async function createProject(input: z.input<typeof NewProject>): Promise<Project> {
  const data = NewProject.parse(input);
  const project: Project = { ...data, id: randomUUID(), name: data.name ?? nameFromBrief(data.brief), createdAt: new Date().toISOString() };
  const dir = projectsDir();
  await fs.mkdir(/*turbopackIgnore: true*/ dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${project.id}.json`);
  const tmp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(/*turbopackIgnore: true*/ tmp, JSON.stringify(project, null, 2), { mode: 0o600 });
  await fs.rename(/*turbopackIgnore: true*/ tmp, file);
  return project;
}

export async function getProject(id: string): Promise<Project | null> {
  if (!ID_PATTERN.test(id)) return null;
  try {
    const text = await fs.readFile(/*turbopackIgnore: true*/ path.join(projectsDir(), `${id}.json`), "utf8");
    return Project.parse(JSON.parse(text));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function listProjects(): Promise<Project[]> {
  let files: string[];
  try {
    files = await fs.readdir(/*turbopackIgnore: true*/ projectsDir());
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const ids = files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
  const projects = await Promise.all(ids.map((id) => getProject(id).catch(() => null)));
  return projects.filter((p): p is Project => p !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
