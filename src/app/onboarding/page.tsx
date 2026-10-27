import { connection } from "next/server";

import { getWasmerAccount } from "@/lib/readiness";

import { Onboarding } from "./onboarding";
import { WasmerSignIn } from "./wasmer-sign-in";

export const metadata = { title: "Get started · Adorable" };

export default async function OnboardingPage({ searchParams }: PageProps<"/onboarding">) {
  await connection(); // reads local credentials on every request
  const account = await getWasmerAccount();
  if (!account) return <WasmerSignIn />;
  const { chatgpt } = await searchParams;
  return <Onboarding wasmerUser={account.username} chatgptResult={typeof chatgpt === "string" ? chatgpt : undefined} />;
}
