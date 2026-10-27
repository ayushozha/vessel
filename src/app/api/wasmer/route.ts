import { readStore, updateStore } from "@/lib/credentials";
import { guardLocal } from "@/lib/guard";

/** The linked Wasmer account, without its token. */
export async function GET(request: Request) {
  const blocked = guardLocal(request);
  if (blocked) return blocked;
  const { wasmer } = await readStore();
  return Response.json(wasmer ? { connected: true, username: wasmer.username, email: wasmer.email } : { connected: false });
}

/** Sign out: forget the token on this machine. It stays listed (and revocable) in the user's Wasmer settings. */
export async function DELETE(request: Request) {
  const blocked = guardLocal(request);
  if (blocked) return blocked;
  await updateStore((s) => {
    delete s.wasmer;
  });
  return new Response(null, { status: 204 });
}
