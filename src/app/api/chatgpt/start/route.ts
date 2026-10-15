import { createAuthorization, localModeError } from "@/lib/chatgpt";
import { effectiveUrl, guardLocal } from "@/lib/guard";

export async function GET(request: Request) {
  const blocked = guardLocal(request);
  if (blocked) return blocked;
  const url = effectiveUrl(request);
  const reason = localModeError(url.href);
  if (reason) return Response.redirect(new URL(`/onboarding?chatgpt=unavailable`, url.origin), 303);

  // OpenAI requires a 127.0.0.1 loopback callback; only the port may vary.
  const redirectUri = `http://127.0.0.1:${url.port || "80"}/api/chatgpt/callback`;
  try {
    const authorizeUrl = await createAuthorization(redirectUri);
    return Response.redirect(authorizeUrl, 303);
  } catch {
    return Response.redirect(new URL(`/onboarding?chatgpt=unreachable`, url.origin), 303);
  }
}
