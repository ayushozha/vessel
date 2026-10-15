// What Vessel can build. Shared by the server and the UI, so it holds no secrets.

export const KINDS = {
  app: {
    name: "App",
    tagline: "A full-stack web app with real data.",
    produces: "React UI · JSON API · Postgres",
    resources: ["Wasmer Edge app", "Managed Postgres"],
    checks: ["Build", "API contract", "Create and reload a record", "Data survives a restart", "Live URL returns 200"],
    color: "var(--s5)",
    placeholder: "A support desk where my team logs customer tickets and marks them resolved",
    examples: ["A support desk my team can triage", "Book club tracker with weekly votes", "Inventory for a small bakery with low-stock alerts"],
  },
  agent: {
    name: "Agent",
    tagline: "An agent that works on its own, with scoped tools.",
    produces: "Instructions · tools · HTTP trigger · run history",
    resources: ["Wasmer Edge app", "Managed Postgres (run history)"],
    checks: ["Build", "Tool calls stay in scope", "Run completes within limits", "Run history is recorded", "Trigger URL returns 200"],
    color: "var(--s4)",
    placeholder: "Every morning, read new support tickets and post a short digest for the team",
    examples: ["Summarize new tickets every morning", "Triage GitHub issues by label", "Watch my logs and propose a fix"],
  },
  mcp: {
    name: "MCP server",
    tagline: "Tools that Claude, ChatGPT or Cursor can call.",
    produces: "MCP tools over HTTP · typed inputs",
    resources: ["Wasmer Edge app"],
    checks: ["Build", "Server lists its tools", "Each tool validates input", "Tool call returns a result", "Live URL returns 200"],
    color: "var(--s6)",
    placeholder: "Tools to search my product catalog and check stock levels",
    examples: ["Search my docs site", "Currency conversion tools", "Look up a package on the Wasmer registry"],
  },
  anything: {
    name: "Anything",
    tagline: "Describe it. Vessel picks the stack.",
    produces: "Detected stack · Anybuild",
    resources: ["Decided by the plan"],
    checks: ["Build", "Start command runs", "Live URL returns 200"],
    color: "var(--s2)",
    placeholder: "A Python API that converts Markdown to PDF",
    examples: ["A Markdown to PDF API in Python", "A static portfolio site", "A Discord bot that answers FAQs"],
  },
} as const;

export type Kind = keyof typeof KINDS;
export const KIND_IDS = Object.keys(KINDS) as Kind[];
