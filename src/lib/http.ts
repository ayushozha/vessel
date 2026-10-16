// Small helpers for the workspace file routes. Server-only.
import type { z } from "zod";

import { guardLocal } from "./guard";
import { getProject } from "./projects";
import { WorkspaceError } from "./workspace";

/** The project id behind a local, same-origin request, or the response refusing it. */
export async function localProject(request: Request, params: Promise<{ id: string }>): Promise<string | Response> {
  const blocked = guardLocal(request);
  if (blocked) return blocked;
  const project = await getProject((await params).id);
  return project ? project.id : Response.json({ error: "Project not found." }, { status: 404 });
}

/** A JSON body of at most `max` bytes that matches `schema`, or the response refusing it. */
export async function jsonBody<T>(request: Request, schema: z.ZodType<T>, max = 1024 * 1024): Promise<T | Response> {
  const buf = await readBody(request, max);
  if (!buf) return tooLarge(max);
  try {
    const parsed = schema.safeParse(JSON.parse(buf.toString("utf8")));
    if (parsed.success) return parsed.data;
  } catch {}
  return Response.json({ error: "Invalid request." }, { status: 400 });
}

/** The request body, or null as soon as it passes `max` bytes (checked while streaming, not after). */
export async function readBody(request: Request, max: number): Promise<Buffer | null> {
  if (Number(request.headers.get("content-length") ?? 0) > max) return null;
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export const tooLarge = (max: number) => Response.json({ error: `Request is larger than ${Math.round(max / 1024 / 1024)} MB.` }, { status: 413 });

const STATUS = { invalid: 400, conflict: 409, missing: 404, limit: 413 } as const;

/** Maps a refused workspace operation to its status; anything else is an unexpected 500. */
export function workspaceErrorResponse(e: unknown): Response {
  if (e instanceof WorkspaceError) return Response.json({ error: e.message }, { status: STATUS[e.code] });
  console.error(e);
  return Response.json({ error: "The workspace could not be changed." }, { status: 500 });
}
