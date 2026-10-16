import { guardLocal } from "@/lib/guard";
import { getProject } from "@/lib/projects";
import { sandboxFor, type LogEntry } from "@/lib/runtime";

/** Server-sent events: recent sandbox log lines, then live ones. The client reconnects after a restart or reset. */
export async function GET(request: Request, ctx: RouteContext<"/api/projects/[id]/runtime/logs">) {
  const blocked = guardLocal(request);
  if (blocked) return blocked;
  const project = await getProject((await ctx.params).id);
  if (!project) return Response.json({ error: "Project not found." }, { status: 404 });

  const sandbox = sandboxFor(project.id);
  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (entry: LogEntry) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(entry)}\n\n`));
      if (!sandbox) {
        controller.enqueue(encoder.encode(`event: idle\ndata: {}\n\n`));
        controller.close();
        return;
      }
      sandbox.logs.slice(-200).forEach(send);
      unsubscribe = sandbox.onLog(send);
      const onState = (state: string) => {
        if (state === "stopped") {
          unsubscribe();
          controller.enqueue(encoder.encode(`event: stopped\ndata: {}\n\n`));
          controller.close();
        }
      };
      sandbox.on("state", onState);
      request.signal.addEventListener("abort", () => {
        unsubscribe();
        sandbox.off("state", onState);
      });
    },
    cancel() {
      unsubscribe();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" } });
}
