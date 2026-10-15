import { redirect } from "next/navigation";
import { connection } from "next/server";

import { getActiveModel } from "@/lib/readiness";

import { NewProject } from "./new-project";

export const metadata = { title: "What are you building? · Vessel" };

export default async function NewProjectPage() {
  await connection(); // reads local credentials on every request
  const active = await getActiveModel();
  if (!active) redirect("/onboarding");
  return <NewProject model={active.model} provider={active.provider} />;
}
