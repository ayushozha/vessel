// Wasmer's GraphQL API (the registry endpoint the dashboard and the `wasmer` CLI use). Server-only.
// Tokens never leave the server; routes return only the account's username and email.

export const registryUrl = () => process.env.WASMER_REGISTRY || "https://registry.wasmer.io/graphql";

export class WasmerError extends Error {}

export async function graphql<T>(query: string, variables: Record<string, unknown> = {}, token?: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(registryUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }) },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new WasmerError("Could not reach Wasmer. Check your connection and try again.");
  }
  const body = (await res.json().catch(() => null)) as { data?: T; errors?: { message: string }[] } | null;
  if (body?.errors?.length) throw new WasmerError(body.errors[0].message);
  if (!res.ok || !body?.data) throw new WasmerError(`Wasmer answered ${res.status}.`);
  return body.data;
}

export type Nonce = { id: string; secret: string; authUrl: string };

/**
 * Start a `wasmer login` style authorization. wasmer.io only accepts a localhost or 127.0.0.1 callback with a
 * port. `secret` and `authUrl` can each be read once, so both come back from this one call.
 */
export async function createNonce(name: string, callbackUrl: string): Promise<Nonce> {
  const data = await graphql<{ newNonce: { nonce: Nonce } }>(
    `mutation NewNonce($input: NewNonceInput!) { newNonce(input: $input) { nonce { id secret authUrl } } }`,
    { input: { name, callbackUrl } },
  );
  return data.newNonce.nonce;
}

export type WasmerUser = { username: string; email?: string };

/** The account behind a token, or null when Wasmer does not accept it. */
export async function viewer(token: string): Promise<WasmerUser | null> {
  const data = await graphql<{ viewer: { username: string; email: string | null } | null }>(`query Viewer { viewer { username email } }`, {}, token);
  return data.viewer ? { username: data.viewer.username, email: data.viewer.email || undefined } : null;
}

/** wasmer.io's sign-up page, which returns to the same authorization once the account exists. */
export function signupUrl(authUrl: string): string {
  const url = new URL(authUrl);
  return `${url.origin}/signup?${new URLSearchParams({ redirect: `${url.pathname}${url.search}` })}`;
}
