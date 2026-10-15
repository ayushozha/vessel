import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";

import { getProject } from "@/lib/projects";
import { getActiveModel } from "@/lib/readiness";

import { Builder } from "./builder";

export default async function BuildPage({ params }: PageProps<"/build/[id]">) {
  await connection(); // reads local files on every request
  const active = await getActiveModel();
  if (!active) redirect("/onboarding");
  const project = await getProject((await params).id);
  if (!project) notFound();
  return <Builder project={project} active={active} />;
}

export async function generateMetadata({ params }: PageProps<"/build/[id]">) {
  const project = await getProject((await params).id);
  return { title: project ? `${project.name} · Vessel` : "Vessel" };
}
