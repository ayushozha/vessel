import { checkCallback, completeAuthorization, localModeError } from "@/lib/chatgpt";
import { consumePendingChatgpt } from "@/lib/credentials";
import { effectiveUrl, guardLocal } from "@/lib/guard";

export async function GET(request: Request) {
  const blocked = guardLocal(request);
  if (blocked) return blocked;
  const url = effectiveUrl(request);
  const done = (status: string) => Response.redirect(new URL(`/onboarding?chatgpt=${status}`, url.origin), 303);
  if (localModeError(url.href)) return done("unavailable");

  // One-time use: the pending transaction is removed before anything else happens.
  const pending = await consumePendingChatgpt();
  const check = checkCallback(url.searchParams, pending);
  if (!check.ok) return done(check.reason);

  try {
    await completeAuthorization(url, pending!, check.clientId);
    return done("connected");
  } catch (e) {
    const reason = e instanceof Error && /^[a-z_]+$/.test(e.message) ? e.message : "exchange_failed";
    return done(reason);
  }
}
