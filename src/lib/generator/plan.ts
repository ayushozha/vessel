// The plan a first generation is built from: every file plus the contracts that let files written in parallel agree.
import { z } from "zod";

import { LIMITS, validatePath } from "../workspace";

const MAX_FILES = 25;

export const Plan = z.object({
  summary: z.string().trim().min(1).max(800),
  files: z
    .array(z.object({ path: z.string().trim().min(1).max(LIMITS.pathLength), purpose: z.string().trim().min(1).max(400) }))
    .min(1)
    .max(MAX_FILES),
  contracts: z
    .object({
      routes: z
        .array(z.object({ method: z.string(), path: z.string(), request: z.string().optional(), response: z.string().optional() }))
        .default([]),
      tables: z.array(z.object({ name: z.string(), columns: z.string() })).default([]),
      dom: z.array(z.string()).default([]),
      env: z.array(z.string()).default([]),
      packages: z.record(z.string(), z.string()).default({}),
      notes: z.string().optional(),
    })
    .default({ routes: [], tables: [], dom: [], env: [], packages: {} }),
});
export type Plan = z.infer<typeof Plan>;

/** The JSON object in a model reply (fences and stray prose tolerated). */
function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object in the plan reply");
  return JSON.parse(text.slice(start, end + 1));
}

/** Parse and check a plan reply; paths are normalized and must be safe and unique. */
export function parsePlan(text: string): { ok: true; plan: Plan } | { ok: false; reason: string } {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch (e) {
    return { ok: false, reason: e instanceof SyntaxError ? `plan is not valid JSON: ${e.message}` : (e as Error).message };
  }
  const parsed = Plan.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: `plan does not match the schema: ${issue.path.join(".") || "(root)"} ${issue.message}` };
  }
  const plan = parsed.data;
  const seen = new Set<string>();
  for (const file of plan.files) {
    const checked = validatePath(file.path);
    if (!checked.ok) return { ok: false, reason: `plan has an unsafe path ${file.path}: ${checked.reason}` };
    if (seen.has(checked.path)) return { ok: false, reason: `plan lists ${checked.path} twice` };
    seen.add(checked.path);
    file.path = checked.path;
  }
  return { ok: true, plan };
}
