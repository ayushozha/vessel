import { redirect } from "next/navigation";
import { connection } from "next/server";

import { listProjects } from "@/lib/projects";
import { getActiveModel } from "@/lib/readiness";

import { ProjectsHome } from "./projects-home";

export const metadata = { title: "Projects · Vessel" };

export default async function ProjectsPage() {
  await connection(); // reads local files on every request
  if ((await listProjects()).length === 0) redirect("/new");
  const active = await getActiveModel();
  return <ProjectsHome model={active ? { provider: active.provider, model: active.model } : null} />;
}
