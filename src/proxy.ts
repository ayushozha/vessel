// Every page and API request needs this launch's token (see src/lib/launch-token.ts).
import { NextResponse, type NextRequest } from "next/server";

import { readLaunchToken, TOKEN_COOKIE, tokenMatches } from "@/lib/launch-token";

const LOCKED_HTML = `<!doctype html><meta charset="utf-8"><title>Vessel is locked</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#fff;color:#0a0a0b}
main{max-width:34rem;padding:2rem}h1{font-weight:400;letter-spacing:-.03em;margin:0 0 .5rem}code{background:#f7f7f9;padding:.1em .35em;border-radius:4px}</style>
<main><h1>Open Vessel from your terminal.</h1><p>For your security, Vessel only accepts requests from the sign-in link it printed when it started:
<code>http://127.0.0.1:3000/auth?token=…</code>. Restarting the server creates a new link.</p></main>`;

export function proxy(request: NextRequest) {
  const expected = readLaunchToken();
  const { pathname, searchParams } = request.nextUrl;
  const origin = `http://${request.headers.get("host") ?? request.nextUrl.host}`;

  if (pathname === "/auth") {
    const given = searchParams.get("token");
    if (!tokenMatches(given, expected)) return locked(pathname);
    const res = NextResponse.redirect(new URL("/", origin), 303);
    res.cookies.set(TOKEN_COOKIE, given!, { httpOnly: true, sameSite: "lax", path: "/" });
    return res;
  }

  const cookie = request.cookies.get(TOKEN_COOKIE)?.value;
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (tokenMatches(cookie, expected) || tokenMatches(bearer, expected)) return NextResponse.next();
  return locked(pathname);
}

function locked(pathname: string) {
  return pathname.startsWith("/api/")
    ? NextResponse.json({ error: "Open Vessel from the sign-in link printed in the terminal." }, { status: 401 })
    : new NextResponse(LOCKED_HTML, { status: 401, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export const config = {
  // Everything except Next's own static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
