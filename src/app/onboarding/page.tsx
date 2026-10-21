import { Onboarding } from "./onboarding";

export const metadata = { title: "Connect a model · Adorable" };

export default async function OnboardingPage({ searchParams }: PageProps<"/onboarding">) {
  const { chatgpt } = await searchParams;
  return <Onboarding chatgptResult={typeof chatgpt === "string" ? chatgpt : undefined} />;
}
