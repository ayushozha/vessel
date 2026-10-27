import { redirect } from "next/navigation";
import { connection } from "next/server";

import { getActiveModel, getWasmerAccount } from "@/lib/readiness";

import { NewProject } from "./new-project";

export const metadata = { title: "What are you building? · Adorable" };

export default async function NewProjectPage() {
  await connection(); // reads local credentials on every request
  if (!(await getWasmerAccount())) redirect("/onboarding");
  const active = await getActiveModel();
  if (!active) redirect("/onboarding");
  return <NewProject model={active.model} provider={active.provider} />;
}
