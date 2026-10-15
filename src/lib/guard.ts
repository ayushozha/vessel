// These routes read local credentials, so they only answer local, same-origin requests.
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The URL the browser actually used. Next's dev server reports `localhost` in request.url even for 127.0.0.1. */
export function effectiveUrl(request: Request): URL {
  const url = new URL(request.url);
  const host = request.headers.get("host");
  if (host) url.host = host;
  return url;
}

export function guardLocal(request: Request): Response | null {
  const url = effectiveUrl(request);
  if (!LOCAL_HOSTS.has(url.hostname)) return Response.json({ error: "Vessel only runs locally." }, { status: 403 });
  if (request.method !== "GET") {
    const origin = request.headers.get("origin");
    if (origin !== url.origin) return Response.json({ error: "Cross-origin request blocked." }, { status: 403 });
  }
  return null;
}
