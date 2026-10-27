import type { ChatMessage } from "@/lib/generator/history";

export const compact = (n: number) => (n < 1000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(2)}M`);

/** Project totals from every finished run: tokens always, dollars only where genai-prices priced the model. */
export function totalSpend(messages: ChatMessage[]) {
  const t = { runs: 0, input: 0, output: 0, cacheRead: 0, costUsd: 0, priced: 0, plan: 0, unpriced: 0 };
  for (const m of messages) {
    const u = m.metrics?.usage;
    if (m.role !== "assistant" || !m.metrics) continue;
    t.runs++;
    if (u) {
      t.input += u.input;
      t.output += u.output;
      t.cacheRead += u.cacheRead;
    } else t.output += m.metrics.outputTokens ?? 0; // runs recorded before usage tracking
    if (m.metrics.costUsd != null) {
      t.costUsd += m.metrics.costUsd;
      t.priced++;
    } else if (m.metrics.pricing === "plan") t.plan++;
    else t.unpriced++;
  }
  return t;
}
