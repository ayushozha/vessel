import { guardLocal } from "@/lib/guard";
import { WasmerError } from "@/lib/wasmer";
import { cancelLogin, loginStatus, startLogin } from "@/lib/wasmer-login";

/** Start a Wasmer sign-in; the UI opens `authUrl` (or `signupUrl` for a new account) and polls GET. */
export async function POST(request: Request) {
  const blocked = guardLocal(request);
  if (blocked) return blocked;
  try {
    return Response.json(await startLogin());
  } catch (e) {
    if (!(e instanceof WasmerError)) console.error(e);
    return Response.json({ error: e instanceof WasmerError ? e.message : "Could not start the Wasmer sign-in." }, { status: 502 });
  }
}

export async function GET(request: Request) {
  const blocked = guardLocal(request);
  if (blocked) return blocked;
  const status = loginStatus(new URL(request.url).searchParams.get("id") ?? "");
  return status ? Response.json(status) : Response.json({ error: "Unknown sign-in." }, { status: 404 });
}

export async function DELETE(request: Request) {
  const blocked = guardLocal(request);
  if (blocked) return blocked;
  cancelLogin(new URL(request.url).searchParams.get("id") ?? "");
  return new Response(null, { status: 204 });
}
