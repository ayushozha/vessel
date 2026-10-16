import { z } from "zod";

import { jsonBody, localProject, readBody, tooLarge, workspaceErrorResponse } from "@/lib/http";
import { createFolder, deleteEntry, findConflicts, isBinary, LIMITS, listEntries, readBytes, renameEntry, validatePath, WorkspaceError, writeFile, writeFiles } from "@/lib/workspace";
import { emitWorkspaceChanged, type WorkspaceChangeSource } from "@/lib/workspace-events";

type Ctx = RouteContext<"/api/projects/[id]/files">;

const UPLOAD_MAX = LIMITS.totalBytes + 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };

function changed(projectId: string, paths: string[], source: WorkspaceChangeSource): Response {
  emitWorkspaceChanged({ projectId, paths, source });
  return Response.json({ paths });
}

/** List files and folders, return one file's content with ?path=, or an image's bytes with ?path=&raw=1. */
export async function GET(request: Request, ctx: Ctx) {
  const id = await localProject(request, ctx.params);
  if (id instanceof Response) return id;

  const params = new URL(request.url).searchParams;
  const wanted = params.get("path");
  if (wanted === null) return Response.json({ files: await listEntries(id) });

  const checked = validatePath(wanted);
  if (!checked.ok) return Response.json({ error: checked.reason }, { status: 400 });
  const data = await readBytes(id, checked.path);
  if (!data) return Response.json({ error: "File not found or too large to show." }, { status: 404 });
  if (params.get("raw") === "1") {
    const type = IMAGE_TYPES[checked.path.split(".").pop()!.toLowerCase()];
    if (!type) return Response.json({ error: "Only images can be previewed." }, { status: 415 });
    // SVG can carry script; the sandbox CSP keeps it inert even when the URL is opened directly.
    const headers = { "Content-Type": type, "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" };
    return new Response(new Uint8Array(data), { headers });
  }
  return isBinary(checked.path, data)
    ? Response.json({ path: checked.path, binary: true, bytes: data.length })
    : Response.json({ path: checked.path, content: data.toString("utf8"), bytes: data.length });
}

/** Multipart: upload files (`file` + `path` pairs, optional `dir`s, `folder`, `overwrite=1`). JSON: create an empty file or folder. */
export async function POST(request: Request, ctx: Ctx) {
  const id = await localProject(request, ctx.params);
  if (id instanceof Response) return id;
  if ((request.headers.get("content-type") ?? "").startsWith("multipart/form-data")) return upload(request, id);

  const body = await jsonBody(request, z.object({ path: z.string(), type: z.enum(["file", "dir"]) }));
  if (body instanceof Response) return body;
  try {
    const paths = body.type === "dir" ? await createFolder(id, body.path) : [(await writeFile(id, body.path, "", { overwrite: false })).path];
    return changed(id, paths, "edit");
  } catch (e) {
    return workspaceErrorResponse(e);
  }
}

async function upload(request: Request, id: string): Promise<Response> {
  const buf = await readBody(request, UPLOAD_MAX);
  if (!buf) return tooLarge(UPLOAD_MAX);
  let form: FormData;
  try {
    form = await new Response(new Uint8Array(buf), { headers: { "content-type": request.headers.get("content-type")! } }).formData();
  } catch {
    return Response.json({ error: "Invalid upload." }, { status: 400 });
  }
  const folder = String(form.get("folder") ?? "").replace(/^\/+|\/+$/g, "");
  const under = (p: string) => (folder ? `${folder}/${p}` : p);
  const files = form.getAll("file");
  const paths = form.getAll("path").map((p) => under(String(p)));
  const dirs = form.getAll("dir").map((d) => under(String(d)));
  if (files.length !== paths.length || (!files.length && !dirs.length) || files.some((f) => typeof f === "string")) {
    return Response.json({ error: "Invalid upload." }, { status: 400 });
  }
  if (form.get("overwrite") !== "1") {
    const conflicts = await findConflicts(id, paths);
    if (conflicts.length) return Response.json({ error: `${conflicts.length} file(s) already exist.`, conflicts }, { status: 409 });
  }
  try {
    const inputs = await Promise.all((files as File[]).map(async (f, i) => ({ path: paths[i], data: new Uint8Array(await f.arrayBuffer()) })));
    const written = (await writeFiles(id, inputs)).map((f) => f.path);
    for (const dir of dirs) {
      try {
        written.push(...(await createFolder(id, dir)));
      } catch (e) {
        if (!(e instanceof WorkspaceError && e.code === "conflict")) throw e;
      }
    }
    return changed(id, written, "upload");
  } catch (e) {
    return workspaceErrorResponse(e);
  }
}

/** Save a file: `content` for text, `base64` for binary. */
export async function PUT(request: Request, ctx: Ctx) {
  const id = await localProject(request, ctx.params);
  if (id instanceof Response) return id;
  const body = await jsonBody(request, z.union([z.object({ path: z.string(), content: z.string() }), z.object({ path: z.string(), base64: z.base64() })]));
  if (body instanceof Response) return body;
  try {
    const data = "content" in body ? body.content : Buffer.from(body.base64, "base64");
    return changed(id, [(await writeFile(id, body.path, data)).path], "edit");
  } catch (e) {
    return workspaceErrorResponse(e);
  }
}

/** Rename or move a file or folder. */
export async function PATCH(request: Request, ctx: Ctx) {
  const id = await localProject(request, ctx.params);
  if (id instanceof Response) return id;
  const body = await jsonBody(request, z.object({ from: z.string(), to: z.string(), overwrite: z.boolean().optional() }));
  if (body instanceof Response) return body;
  try {
    return changed(id, await renameEntry(id, body.from, body.to, { overwrite: body.overwrite }), "rename");
  } catch (e) {
    return workspaceErrorResponse(e);
  }
}

/** Delete a file, or a folder and everything in it, with ?path=. */
export async function DELETE(request: Request, ctx: Ctx) {
  const id = await localProject(request, ctx.params);
  if (id instanceof Response) return id;
  try {
    return changed(id, await deleteEntry(id, new URL(request.url).searchParams.get("path") ?? ""), "delete");
  } catch (e) {
    return workspaceErrorResponse(e);
  }
}
