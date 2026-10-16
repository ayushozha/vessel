import { localProject, readBody, tooLarge, workspaceErrorResponse } from "@/lib/http";
import { emitWorkspaceChanged } from "@/lib/workspace-events";
import { importZip, previewZip, ZIP_LIMITS } from "@/lib/zip-import";

/** Import a zip (raw body). `?dryRun=1` only reports {files, folders, conflicts, skipped, totalBytes}; `?overwrite=1` replaces conflicts; `?folder=` imports into a folder. */
export async function POST(request: Request, ctx: RouteContext<"/api/projects/[id]/files/import-zip">) {
  const id = await localProject(request, ctx.params);
  if (id instanceof Response) return id;
  const buf = await readBody(request, ZIP_LIMITS.archiveBytes);
  if (!buf) return tooLarge(ZIP_LIMITS.archiveBytes);
  const query = new URL(request.url).searchParams;
  const folder = query.get("folder") ?? "";
  try {
    if (query.get("dryRun") === "1") return Response.json(await previewZip(id, buf, { folder }));
    const { plan, changed } = await importZip(id, buf, { overwrite: query.get("overwrite") === "1", folder });
    emitWorkspaceChanged({ projectId: id, paths: changed, source: "zip" });
    return Response.json({ ...plan, written: changed });
  } catch (e) {
    return workspaceErrorResponse(e);
  }
}
