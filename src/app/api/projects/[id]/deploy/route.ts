import { DeployError, deployStatus, startDeploy } from "@/lib/deploy";
import { localProject } from "@/lib/http";
import { WasmerError } from "@/lib/wasmer";

const STATUS = { unlinked: 401, busy: 409, empty: 400 } as const;

/** The current publish (if any) and the project's Wasmer app. */
export async function GET(request: Request, ctx: RouteContext<"/api/projects/[id]/deploy">) {
  const id = await localProject(request, ctx.params);
  if (id instanceof Response) return id;
  return Response.json(await deployStatus(id));
}

/** Publish the project to Wasmer Edge with Anybuild. */
export async function POST(request: Request, ctx: RouteContext<"/api/projects/[id]/deploy">) {
  const id = await localProject(request, ctx.params);
  if (id instanceof Response) return id;
  try {
    return Response.json(await startDeploy(id), { status: 202 });
  } catch (e) {
    if (e instanceof DeployError) return Response.json({ error: e.message }, { status: STATUS[e.code] });
    if (e instanceof WasmerError) return Response.json({ error: e.message }, { status: 502 });
    console.error(e);
    return Response.json({ error: "Publishing could not start." }, { status: 500 });
  }
}
