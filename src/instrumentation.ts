// Runs once when the Adorable server starts: create this launch's access token and print the sign-in link.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { createLaunchToken } = await import("./lib/launch-token");
  const token = createLaunchToken();
  const port = process.env.PORT || "3000";
  console.log(`\n  Adorable is running. Open this link to sign in (valid until the server restarts):\n  http://127.0.0.1:${port}/auth?token=${token}\n`);
}
